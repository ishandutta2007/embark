const ProcessWrapper = require('../process/processWrapper');
const Mocha = require('mocha');
const async = require('async');
const cloneDeep = require('clone-deep');
const constants = require('../constants');
const TestLogger = require('../tests/test_logger');
const Engine = require('../core/engine');
const Events = require('../core/events');
const Web3 = require('web3');
const i18n = require('../i18n/i18n');

let testProcess;

function getSimulator() {
  try {
    return require('ganache-cli');
  } catch (e) {
    const moreInfo = __('For more information see https://github.com/trufflesuite/ganache-cli');
    if (e.code === 'MODULE_NOT_FOUND') {
      console.error(__('Simulator not found; Please install it with "%s"', 'npm install ganache-cli --save'));
      console.error(moreInfo);
      throw e;
    }
    console.error("==============");
    console.error(__("Tried to load Ganache CLI (testrpc), but an error occurred. This is a problem with Ganache CLI"));
    console.error(moreInfo);
    console.error("==============");
    throw e;
  }
}

class TestProcess extends ProcessWrapper {
 constructor(options) {
   super(options);
   this.options = options;
   this.simOptions = this.options.simulatorOptions || {};
   this.events = new Events();
   this.contracts = {};
   this.accounts = {};
   this.ready = true;
   this.builtContracts = options.builtContracts;
   this.compiledContracts = options.compiledContracts;
   this.file = options.file;
   this.startTime = Date.now();

   console.log(Date.now());
   console.log(Date.now() - this.startTime, 'Constructing');
   this.startTime = Date.now();
   i18n.setOrDetectLocale(options.locale);
   this.init();
 }

 initEngine() {
   console.log(Date.now() - this.startTime, 'Web3');
   this.startTime = Date.now();
   this.web3 = new Web3();
   if (this.simOptions.node) {
     this.web3.setProvider(new this.web3.providers.HttpProvider(this.simOptions.node));
   } else {
     console.log(Date.now() - this.startTime, 'getting simulator');
     this.startTime = Date.now();
     this.sim = getSimulator();
     console.log(Date.now() - this.startTime, 'got simulator');
     this.startTime = Date.now();
     this.web3.setProvider(this.sim.provider(this.simOptions));
   }

   console.log(Date.now() - this.startTime, 'new engine');
   this.startTime = Date.now();
   this.engine = new Engine({
     env: this.options.env || 'test',
     // TODO: config will need to detect if this is a obj
     embarkConfig: this.options.embarkConfig || 'embark.json',
     interceptLogs: false
   });

   console.log(Date.now() - this.startTime, 'init engine');
   this.startTime = Date.now();
   this.engine.init({
     logger: new TestLogger({logLevel: 'debug'}),
     events: this.events
   });

   this.versions_default = this.engine.config.contractsConfig.versions;
   // Reset contract config to nothing to make sure we deploy only what we want
   this.engine.config.contractsConfig = {contracts: {}, versions: this.versions_default};

   console.log(Date.now() - this.startTime, 'start library service');
   this.startTime = Date.now();
   this.engine.startService("libraryManager");
   console.log(Date.now() - this.startTime, 'start codeRunner service');
   this.startTime = Date.now();
   this.engine.startService("codeRunner");
   console.log(Date.now() - this.startTime, 'start web3 service');
   this.startTime = Date.now();
   this.engine.startService("web3", {
     web3: this.web3
   });
   console.log(Date.now() - this.startTime, 'start deployement service');
   this.startTime = Date.now();
   this.engine.startService("deployment", {
     trackContracts: false
   });
   console.log(Date.now() - this.startTime, 'start condeGenerator service');
   this.startTime = Date.now();
   this.engine.startService("codeGenerator");
   this.startTime = Date.now();

   console.log(Date.now() - this.startTime, 'clones');
   this.startTime = Date.now();
   this.engine.contractsManager.contracts = cloneDeep(this.builtContracts);
   this.engine.contractsManager.compiledContracts = cloneDeep(this.compiledContracts);
 }

 initGlobals() {
   global.embark = this;
   global.config = this.config.bind(this);

   // TODO: this global here might not be necessary at all
   global.web3 = global.embark.web3;

   global.contract = function (describeName, callback) {
     return Mocha.describe(describeName, callback);
   };
 }

 initMocha() {
   this.mocha = new Mocha();
   this.mocha.addFile(this.file);

   this.mocha.suite.timeout(0);
   this.mocha.suite.beforeEach('Wait for deploy', (done) => {
     this.onReady(() => {
       done();
     });
   });
 }

 init() {
   console.log(Date.now() - this.startTime, 'initing engine');
   this.startTime = Date.now();
   this.initEngine();
   console.log(Date.now() - this.startTime, 'initing globals');
   this.startTime = Date.now();
   this.initGlobals();
   console.log(Date.now() - this.startTime, 'initing mocha');
   this.startTime = Date.now();
   this.initMocha();
 }

  onReady(callback) {
    if (this.ready) {
      return callback();
    }
    this.events.once('test-ready', () => {
      callback();
    });
  }

 start() {
   this.mocha.run(function(failures) {
     // Mocha prints the error already
     process.send({result: 'done', failures});
   });
 }

  config(options, callback) {
    if (!callback) {
      callback = function () {
      };
    }
    if (!options.contracts) {
      throw new Error(__('No contracts specified in the options'));
    }
    this.ready = false;

    // Reset contracts
    this.engine.contractsManager.contracts = cloneDeep(this.builtContracts);
    this.engine.contractsManager.compiledContracts = cloneDeep(this.compiledContracts);

    this._deploy(options, (err, accounts) => {
      this.ready = true;
      this.events.emit('test-ready');
      if (err) {
        console.error(err.red);
        return callback(err);
      }
      callback(null, accounts);
    });
  }

  _deploy(config, callback) {
    const self = this;
    async.waterfall([
      function getConfig(next) {
        self.engine.config.contractsConfig = {contracts: config.contracts, versions: self.versions_default};
        self.engine.events.emit(constants.events.contractConfigChanged, self.engine.config.contractsConfig);
        next();
      },
      function deploy(next) {
        self.engine.deployManager.gasLimit = 6000000;
        self.engine.contractsManager.gasLimit = 6000000;
        self.engine.deployManager.fatalErrors = true;
        self.engine.deployManager.deployOnlyOnConfig = true;
        self.engine.events.request('deploy:contracts', next);
      },
      function getAccounts(next) {
        self.web3.eth.getAccounts(function (err, accounts) {
          if (err) {
            return next(err);
          }
          self.accounts = accounts;
          self.web3.eth.defaultAccount = accounts[0];
          next();
        });
      },
      function createContractObject(next) {
        async.each(Object.keys(self.engine.contractsManager.contracts), (contractName, eachCb) => {
          const contract = self.engine.contractsManager.contracts[contractName];
          if (!self.contracts[contractName]) {
            self.contracts[contractName] = {};
          }
          Object.assign(self.contracts[contractName], new self.web3.eth.Contract(contract.abiDefinition, contract.deployedAddress,
            {from: self.web3.eth.defaultAccount, gas: 6000000}));
          eachCb();
        }, next);
      }
    ], function (err) {
      if (err) {
        console.log(__('terminating due to error'));
        return callback(err);
      }
      callback();
    });
  }

  require(module) {
    if (module.startsWith('Embark/contracts/')) {
      const contractName = module.substr(17);
      if (this.contracts[contractName]) {
        return this.contracts[contractName];
      }
      let contract = this.engine.contractsManager.contracts[contractName];
      if (!contract) {
        const contractNames = Object.keys(this.engine.contractsManager.contracts);
        // It is probably an instanceof
        contractNames.find(contrName => {
          // Find a contract with a similar name
          if (contractName.indexOf(contrName) > -1) {
            contract = this.engine.contractsManager.contracts[contrName];
            return true;
          }
          return false;
        });
        // If still nothing, assign bogus one, we will redefine it anyway on deploy
        if (!contract) {
          console.warn(__('Could not recognize the contract name "%s"', contractName));
          console.warn(__('If it is an instance of another contract, it will be reassigned on deploy'));
          console.warn(__('Otherwise, you can rename the contract to contain the parent contract in the name eg: Token2 for Token'));
          contract = this.engine.contractsManager.contracts[contractNames[0]];
        }
      }
      this.contracts[contractName] = new this.web3.eth.Contract(contract.abiDefinition, contract.address,
        {from: this.web3.eth.defaultAccount, gas: 6000000});
      return this.contracts[contractName];
    }
    throw new Error(__('Unknown module %s', module));
  }
}

process.on('message', (msg) => {
  if (msg.action === 'init') {
    testProcess = new TestProcess(msg.options);
    testProcess.start();
    return process.send({result: 'initiated'});
  }
});
