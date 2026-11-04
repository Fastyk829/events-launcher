'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { retryDownload, withMinecraftDownloads } = require('../src/main/minecraft-downloads.cjs');

test('starts with six downloads and reduces concurrency after a network failure', async () => {
  const profiles = [];
  const result = await withMinecraftDownloads(async options => {
    profiles.push([options.assetsDownloadConcurrency, options.librariesDownloadConcurrency]);
    assert.equal(options.skipRevalidate, false);
    assert.equal(options.skipPrevalidate, false);
    if (profiles.length === 1) throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    return 'complete';
  }, () => {});
  assert.equal(result, 'complete');
  assert.deepEqual(profiles, [[6, 6], [2, 2]]);
});

test('retries nested network failures and resumes operation', async () => {
  let attempts = 0; const notices = [];
  const result = await retryDownload(async () => {
    if (++attempts < 3) throw new AggregateError([new Error('fetch failed', {
      cause: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
    })]);
    return 'complete';
  }, message => notices.push(message), async () => {});
  assert.equal(result, 'complete'); assert.equal(attempts, 3); assert.equal(notices.length, 2);
});

test('rechecks corrupted files but stops after three attempts', async () => {
  let attempts = 0;
  await assert.rejects(retryDownload(async () => { attempts++; throw new Error('sha1 checksum not match'); },
    () => {}, async () => {}), /checksum/);
  assert.equal(attempts, 3);
});

test('does not retry filesystem permission errors', async () => {
  let attempts = 0;
  await assert.rejects(retryDownload(async () => { attempts++; throw Object.assign(new Error('denied'), { code: 'EPERM' }); },
    () => {}, async () => {}), /denied/);
  assert.equal(attempts, 1);
});

test('retries transient Electron network errors', async () => {
  let attempts = 0;
  await retryDownload(async () => {
    if (++attempts === 1) throw new Error('net::ERR_CONNECTION_TIMED_OUT');
  }, () => {}, async () => {});
  assert.equal(attempts, 2);
});
