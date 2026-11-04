'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createLauncherUpdater } = require('../src/main/launcher-updater.cjs');

test('automatically downloads a required update and blocks launch until restart', async () => {
  const mock = new EventEmitter();
  let downloads = 0, installed = false, checks = 0;
  mock.checkForUpdates = async () => { checks++; mock.emit('update-available', { version: '0.2.0' }); };
  mock.downloadUpdate = async () => { downloads++; mock.emit('download-downloaded-typo'); mock.emit('update-downloaded'); };
  mock.quitAndInstall = () => { installed = true; };
  const updater = createLauncherUpdater(mock, () => undefined, true);
  await assert.rejects(updater.download(), /Нет обновления/);
  await updater.check();
  assert.equal(checks, 1);
  assert.equal(updater.state().version, '0.2.0');
  await assert.rejects(updater.ensureCurrent(), /Для запуска/);
  assert.equal(downloads, 1);
  assert.equal(updater.state().phase, 'downloaded');
  updater.install();
  assert.equal(installed, true);
  assert.equal(mock.autoDownload, false);
  assert.equal(mock.allowPrerelease, false);
});

test('unavailable feed does not falsely require an update; every launch checks again', async () => {
  const mock = new EventEmitter();
  let checks = 0;
  mock.checkForUpdates = async () => {
    if (++checks === 1) throw new Error('offline');
    mock.emit('update-not-available');
  };
  const updater = createLauncherUpdater(mock, () => {}, true);
  await updater.ensureCurrent();
  assert.equal(updater.state().phase, 'error');
  assert.equal(updater.state().version, null);
  assert.equal((await updater.retry()).phase, 'up-to-date');
  await updater.ensureCurrent();
  assert.equal(checks, 3);
});

test('failed download keeps launch blocked and retries the required update', async () => {
  const mock = new EventEmitter();
  let downloads = 0;
  mock.checkForUpdates = async () => mock.emit('update-available', { version: '0.2.0' });
  mock.downloadUpdate = async () => {
    if (++downloads === 1) throw new Error('offline');
    mock.emit('update-downloaded');
  };
  const updater = createLauncherUpdater(mock, () => {}, true);
  await updater.check();
  assert.equal(updater.state().phase, 'error');
  await assert.rejects(updater.ensureCurrent(), /Для запуска/);
  assert.equal((await updater.retry()).phase, 'downloaded');
  assert.equal(downloads, 2);
});

test('unpackaged app does not attempt update checks', async () => {
  const mock = new EventEmitter();
  mock.checkForUpdates = () => { throw new Error('must not run in dev'); };
  const updater = createLauncherUpdater(mock, () => undefined, false);
  assert.equal((await updater.check()).phase, 'unavailable');
});
