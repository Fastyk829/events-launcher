'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { formatInstallError } = require('../src/main/install-error.cjs');

test('expands empty AggregateError into download causes without URL credentials', () => {
  const cause = Object.assign(new Error('connect timed out'), { code: 'ETIMEDOUT' });
  const download = Object.assign(new Error('fetch failed', { cause }), {
    urls: ['https://user:password@libraries.minecraft.net/example.jar?token=secret'],
  });
  const result = formatInstallError(new AggregateError([download, download]));
  assert.match(result, /ETIMEDOUT: connect timed out/);
  assert.match(result, /libraries.minecraft.net\/example.jar/);
  assert.doesNotMatch(result, /secret|password|AggregateError/);
});

test('handles recursive and empty errors', () => {
  const error = new Error('broken'); error.cause = error;
  assert.equal(formatInstallError(error), 'broken');
  assert.equal(formatInstallError(new AggregateError([])), 'Неизвестная ошибка установки');
});
