const async = require('async');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const utils = require('../utils/utils');
const ProcessLauncher = require('../process/processLauncher');
const cloneDeep = require('clone-deep');
const Engine = require('../core/engine');
const Logger = require('../core/logger');
const Events = require('../core/events');

function getFilesFromDir(filePath, cb) {
  fs.readdir(filePath, (err, files) => {
    if (err) {
      return cb(err);
    }
    const testFiles = files.filter((file) => {
      // Only keep the .js files
      // TODO: make this a configuration in embark.json
      return file.substr(-3) === '.js';
    }).map((file) => {
      return path.join(filePath, file);
    });
    cb(null, testFiles);
  });
}

module.exports = {
  run: function (filePath) {
    process.env.isTest = true;
    let failures = 0;
    let builtContracts;
    let compiledContracts;
    const events = new Events();
    const logger = new Logger({logLevel: 'debug', events: events});
    if (!filePath) {
      filePath = 'test/';
    }

    async.waterfall([
      function build(next) {
        const engine = new Engine({
          env: 'test',
          // TODO: config will need to detect if this is a obj
          embarkConfig: 'embark.json',
          interceptLogs: false
        });

        engine.init({
          logger,
          events
        });

        engine.startService("libraryManager");
        engine.startService("codeRunner");
        engine.startService("deployment", {
          trackContracts: false
        });
        engine.startService("codeGenerator");

        console.info('Compiling contracts'.cyan);
        engine.contractsManager.build((err) => {
          if (err) {
            console.error(__('Error while building contracts').red);
            return next(err);
          }
          builtContracts = cloneDeep(engine.contractsManager.contracts);
          compiledContracts = cloneDeep(engine.contractsManager.compiledContracts);
          next();
        });
      },
      function getFiles(next) {
        if (filePath.substr(-1) !== '/') {
          return next(null, [filePath]);
        }
        getFilesFromDir(filePath, (err, files) => {
          if (err) {
            console.error('Error while reading the directory');
            return next(err);
          }
          next(null, files);
        });
      },
      function executeForAllFiles(files, next) {
        const filePath = utils.joinPath(__dirname, `../processes/testProcess.js`);
        console.log('Starting process', filePath);
        async.eachLimit(files, os.cpus().length, (file, eachCb) => {
          const testProcess = new ProcessLauncher({
            modulePath: filePath,
            logger,
            events,
            exitCallback: function (code) {
              console.error('Test process ended with code ' + code);
            }
          });
          console.log('Sending process', file);
          testProcess.send({action: 'init', options: {builtContracts, compiledContracts, file}});
          testProcess.once('result', 'done', (msg) => {
            console.log('Done');
            failures += msg.failures;
            eachCb();
          });
        }, next);
      }
    ], (err) => {
      if (err) {
        console.error(err);
        process.exit(1);
      }
      if (failures) {
        console.error(` > Total number of failures: ${failures}`.red.bold);
      } else {
        console.log(' > All tests passed'.green.bold);
      }

      // Clean contracts folder for next test run
      fs.remove('.embark/contracts', (_err) => {
        process.exit(failures);
      });
    });
  }
};
