// @ts-check

'use strict';

const { isMainThread } = require('worker_threads');
const {
  ERR_WORKER_UNSUPPORTED_OPERATION,
} = require('internal/errors').codes;

/** @type {import('internal/watchdog').SigintWatchdog} */
let sigintWatchdog;
function getSigintWatchdog() {
  if (!sigintWatchdog) {
    const { SigintWatchdog } = require('internal/watchdog');
    sigintWatchdog = new SigintWatchdog();
  }
  return sigintWatchdog;
}

/**
 * @param {boolean} enable
 */
function setTraceSigInt(enable) {
  if (!isMainThread)
    throw new ERR_WORKER_UNSUPPORTED_OPERATION('Calling util.setTraceSigInt');
  if (enable) {
    getSigintWatchdog().start();
  } else {
    getSigintWatchdog().stop();
  }
};

module.exports = {
  setTraceSigInt,
};
