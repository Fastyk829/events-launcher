'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: wait } = require('node:timers/promises');
const { fetchWithIdleTimeout } = require('../src/main/storage-fetch.cjs');

test('ongoing downloads may last longer than the inactivity timeout', async () => {
  let count = 0;
  const response = await fetchWithIdleTimeout(async () => new Response(new ReadableStream({
    async pull(controller) {
      await wait(20);
      if (++count <= 8) controller.enqueue(new Uint8Array([65]));
      else controller.close();
    },
  })), 'https://example.com', {}, 100);
  assert.equal(await response.text(), 'AAAAAAAA');
});

test('stalled connection aborts and is reported as retryable ETIMEDOUT', async () => {
  await assert.rejects(fetchWithIdleTimeout((_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }), 'https://example.com', {}, 10), { code: 'ETIMEDOUT' });
});

test('cancelling a response releases the underlying stream', async () => {
  let cancelled = false;
  const response = await fetchWithIdleTimeout(async () => new Response(new ReadableStream({
    cancel() { cancelled = true; },
  })), 'https://example.com', {}, 100);
  await response.body.cancel();
  assert.equal(cancelled, true);
});

test('startup deadline is removed once download data starts arriving', async () => {
  let count = 0;
  const response = await fetchWithIdleTimeout(async () => new Response(new ReadableStream({
    async pull(controller) {
      if (++count > 5) { controller.close(); return; }
      if (count > 1) await wait(30);
      controller.enqueue(new Uint8Array([65]));
    },
  })), 'https://example.com', {}, 200, 50);
  assert.equal(await response.text(), 'AAAAA');
});

test('deadline releases caller even when fetch ignores AbortSignal', { timeout: 1000 }, async () => {
  await assert.rejects(fetchWithIdleTimeout(() => new Promise(() => {}),
    'https://example.com', {}, 20), { code: 'ETIMEDOUT' });
});

test('deadline releases stalled body even if both read and cancel ignore abort', { timeout: 1000 }, async () => {
  const response = await fetchWithIdleTimeout(async () => new Response(new ReadableStream({
    pull() { return new Promise(() => {}); },
    cancel() { return new Promise(() => {}); },
  })), 'https://example.com', {}, 20);
  await assert.rejects(response.text(), { code: 'ETIMEDOUT' });
});
