'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  memoryLimits, validMemoryMb, validNickname, normalizeSettings, validateSettings,
} = require('../src/main/launcher-settings.cjs');

test('RAM is bounded by physical memory, has 512-MB steps and reserves Windows memory', () => {
  const l8 = memoryLimits(8 * 1024 ** 3);
  assert.equal(l8.minimumMemoryMb, 2048);
  assert.equal(l8.maximumMemoryMb, 6144);
  assert.equal(l8.totalMemoryMb, 8192);
  assert.equal(memoryLimits(32 * 1024 ** 3).maximumMemoryMb, 16384);
  assert.equal(validMemoryMb(4096, l8), true);
  for (const bad of [-1, 0, 512, 4000, 6145, 8192, '4096']) {
    assert.equal(validMemoryMb(bad, l8), false);
  }
});

test('settings survive normalization and reject unsupported values', () => {
  const limits = memoryLimits(8 * 1024 ** 3);
  assert.deepEqual(normalizeSettings({ nickname: 'Player12', memoryMb: 5120, gpuPreference: 'discrete' }, limits),
    { nickname: 'Player12', memoryMb: 5120, gpuPreference: 'discrete', jvmArguments: '' });
  assert.deepEqual(normalizeSettings(null, limits), { nickname: '', memoryMb: 4096, gpuPreference: 'automatic', jvmArguments: '' });
  assert.equal(validNickname(''), true);
  assert.equal(validNickname('ab'), false);
  assert.equal(validNickname('Steve_1'), true);
  assert.throws(() => validateSettings({ nickname: 'Some!User', memoryMb: 4096, gpuPreference: 'automatic' }, limits));
  assert.throws(() => validateSettings({ nickname: 'Steve', memoryMb: 16_384, gpuPreference: 'automatic' }, limits));
  assert.deepEqual(validateSettings({ nickname: '', memoryMb: 2048, gpuPreference: 'integrated' }, limits),
    { nickname: '', memoryMb: 2048, gpuPreference: 'integrated', jvmArguments: '' });
  assert.throws(() => validateSettings({
    nickname: 'Steve', memoryMb: 4096, gpuPreference: 'unknown',
  }, limits), /invalid_gpu_preference/);
});
