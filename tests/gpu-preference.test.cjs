'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const {
  applyGpuPreference, validGpuPreference, withGpuPreference, javaExecutable,
} = require('../src/main/gpu-preference.cjs');

const JAVA = 'C:\\Users\\Player\\AppData\\Roaming\\Events Launcher\\java\\bin\\javaw.exe';

function fakeRegistry(initial = null) {
  let data = initial;
  const actions = [];
  async function runner(program, args) {
    assert.equal(program, 'reg.exe');
    actions.push(args);
    if (args[0] === 'query') {
      if (data === null) throw Object.assign(new Error('missing'), { code: 1 });
      return { stdout: '\r\n  ' + JAVA + '    REG_SZ    ' + data + '\r\n' };
    }
    if (args[0] === 'add') {
      data = args[args.indexOf('/d') + 1];
      return { stdout: 'OK' };
    }
    if (args[0] === 'delete') {
      data = null;
      return { stdout: 'OK' };
    }
    throw Error('Unexpected registry command');
  }
  return { runner, actions, get: () => data, manual: (next) => { data = next; } };
}

test('GPU preference options only permit documented modes and Windows Java executables', () => {
  for (const item of ['automatic', 'integrated', 'discrete']) {
    assert.equal(validGpuPreference(item), true);
  }
  assert.equal(validGpuPreference('other'), false);
  assert.equal(javaExecutable(JAVA), true);
  assert.equal(javaExecutable('C:\\temp\\minecraft.exe'), false);
  assert.equal(javaExecutable('javaw.exe'), false);
  assert.equal(withGpuPreference('AutoHDREnable=1;GpuPreference=1;', 'discrete'),
    'AutoHDREnable=1;GpuPreference=2;');
  assert.equal(withGpuPreference('GpuPreference=2;', 'automatic'), null);
});

test('explicit GPU selection modifies Java preference and automatic restores original Windows setting', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'events-gpu-'));
  const statePath = join(folder, 'gpu-preference.json');
  const reg = fakeRegistry('AutoHDREnable=1;GpuPreference=1;');
  try {
    await applyGpuPreference(JAVA, 'discrete', statePath, reg.runner, 'win32');
    assert.equal(reg.get(), 'AutoHDREnable=1;GpuPreference=2;');
    assert.equal(JSON.parse(await readFile(statePath, 'utf8')).original,
      'AutoHDREnable=1;GpuPreference=1;');
    await applyGpuPreference(JAVA, 'integrated', statePath, reg.runner, 'win32');
    assert.equal(reg.get(), 'AutoHDREnable=1;GpuPreference=1;');
    await applyGpuPreference(JAVA, 'automatic', statePath, reg.runner, 'win32');
    assert.equal(reg.get(), 'AutoHDREnable=1;GpuPreference=1;');
    await assert.rejects(readFile(statePath, 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('automatic does not overwrite Windows graphics settings that launcher never changed', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'events-gpu-'));
  const state = join(folder, 'gpu.json');
  const reg = fakeRegistry('GpuPreference=2;');
  try {
    await applyGpuPreference(JAVA, 'automatic', state, reg.runner, 'win32');
    assert.equal(reg.actions.length, 0);
    assert.equal(reg.get(), 'GpuPreference=2;');
    await applyGpuPreference(JAVA, 'integrated', state, reg.runner, 'win32');
    reg.manual('GpuPreference=2;');
    await applyGpuPreference(JAVA, 'automatic', state, reg.runner, 'win32');
    assert.equal(reg.get(), 'GpuPreference=2;');
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('no existing Windows preference restores to absence, and non-Windows ignores automatic', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'events-gpu-'));
  const reg = fakeRegistry(null);
  try {
    await applyGpuPreference(JAVA, 'discrete', join(folder, 'gpu.json'), reg.runner, 'win32');
    assert.equal(reg.get(), 'GpuPreference=2;');
    await applyGpuPreference(JAVA, 'automatic', join(folder, 'gpu.json'), reg.runner, 'win32');
    assert.equal(reg.get(), null);
    await applyGpuPreference(JAVA, 'automatic', join(folder, 'gpu.json'), reg.runner, 'linux');
    await assert.rejects(applyGpuPreference(JAVA, 'discrete',
      join(folder, 'gpu.json'), reg.runner, 'linux'), /Windows/);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
