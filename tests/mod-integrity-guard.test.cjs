'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, rm, symlink } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { createHash } = require('node:crypto');
const { createModIntegrityGuard, hashFile } = require('../src/main/mod-integrity-guard.cjs');

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

test('mod integrity guard: passes when mods exactly match expected list', async () => {
  const root = await mkdtemp(join(tmpdir(), 'guard-pass-'));
  const modsRoot = join(root, 'mods');
  await mkdir(modsRoot, { recursive: true });

  const mod1Content = Buffer.from('mod-one-content');
  const mod2Content = Buffer.from('mod-two-content');
  await writeFile(join(modsRoot, 'mod1.jar'), mod1Content);
  await writeFile(join(modsRoot, 'mod2.jar'), mod2Content);

  const expected = new Map([
    ['mod1.jar', { name: 'mod1.jar', size: mod1Content.length, sha256: sha256(mod1Content) }],
    ['mod2.jar', { name: 'mod2.jar', size: mod2Content.length, sha256: sha256(mod2Content) }],
  ]);

  const guard = createModIntegrityGuard({ modsRoot, expectedMods: expected });
  try {
    await guard.assertClean();
  } finally {
    guard.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('mod integrity guard: rejects unexpected/cheat jar added to mods', async () => {
  const root = await mkdtemp(join(tmpdir(), 'guard-reject-'));
  const modsRoot = join(root, 'mods');
  await mkdir(modsRoot, { recursive: true });

  const legitMod = Buffer.from('legit-mod');
  await writeFile(join(modsRoot, 'legit.jar'), legitMod);
  await writeFile(join(modsRoot, 'xray-cheat.jar'), Buffer.from('cheat-bytecode'));

  const expected = new Map([
    ['legit.jar', { name: 'legit.jar', size: legitMod.length, sha256: sha256(legitMod) }],
  ]);

  const guard = createModIntegrityGuard({ modsRoot, expectedMods: expected });
  try {
    await assert.rejects(
      () => guard.assertClean(),
      /Обнаружен посторонний мод: xray-cheat\.jar/,
    );
  } finally {
    guard.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('mod integrity guard: rejects modified mod (hash or size mismatch)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'guard-tamper-'));
  const modsRoot = join(root, 'mods');
  await mkdir(modsRoot, { recursive: true });

  const origContent = Buffer.from('original-unmodified-mod');
  const tamperedContent = Buffer.from('tampered-modified-mod123'); // different size
  await writeFile(join(modsRoot, 'mod.jar'), tamperedContent);

  const expected = new Map([
    ['mod.jar', { name: 'mod.jar', size: origContent.length, sha256: sha256(origContent) }],
  ]);

  const guard = createModIntegrityGuard({ modsRoot, expectedMods: expected });
  try {
    await assert.rejects(
      () => guard.assertClean(),
      /Размер мода не совпадает со сборкой: mod\.jar/,
    );
  } finally {
    guard.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('mod integrity guard: rejects missing required mod', async () => {
  const root = await mkdtemp(join(tmpdir(), 'guard-missing-'));
  const modsRoot = join(root, 'mods');
  await mkdir(modsRoot, { recursive: true });

  const expected = new Map([
    ['required.jar', { name: 'required.jar', size: 100, sha256: 'a'.repeat(64) }],
  ]);

  const guard = createModIntegrityGuard({ modsRoot, expectedMods: expected });
  try {
    await assert.rejects(
      () => guard.assertClean(),
      /Отсутствует обязательный мод сборки: required\.jar/,
    );
  } finally {
    guard.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('mod integrity guard: rejects symbolic links in mods directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'guard-symlink-'));
  const modsRoot = join(root, 'mods');
  await mkdir(modsRoot, { recursive: true });

  const targetFile = join(root, 'target.jar');
  await writeFile(targetFile, 'content');
  try {
    await symlink(targetFile, join(modsRoot, 'symlink.jar'));
  } catch (err) {
    // If running in an environment without Windows symlink privilege, skip symlink assertion
    await rm(root, { recursive: true, force: true });
    return;
  }

  const guard = createModIntegrityGuard({ modsRoot, expectedMods: new Map() });
  try {
    await assert.rejects(
      () => guard.assertClean(),
      /В папке mods обнаружена символическая ссылка: symlink\.jar/,
    );
  } finally {
    guard.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('mod integrity guard: runtime watcher triggers onViolation when a file is added during gameplay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'guard-watcher-'));
  const modsRoot = join(root, 'mods');
  await mkdir(modsRoot, { recursive: true });

  const legit = Buffer.from('legit-game-mod');
  await writeFile(join(modsRoot, 'legit.jar'), legit);

  const expected = new Map([
    ['legit.jar', { name: 'legit.jar', size: legit.length, sha256: sha256(legit) }],
  ]);

  const guard = createModIntegrityGuard({ modsRoot, expectedMods: expected });
  try {
    await guard.assertClean();
    guard.markRuntimeStarted();

    const violationPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Watcher did not trigger onViolation within 2s')), 2000);
      guard.onViolation((error) => {
        clearTimeout(timer);
        resolve(error);
      });
    });

    // Toss in a foreign mod while "game is running"
    await writeFile(join(modsRoot, 'injected-cheat.jar'), 'hacked');

    const error = await violationPromise;
    assert.match(error.message, /Обнаружен посторонний мод: injected-cheat\.jar/);
    await assert.rejects(() => guard.assertClean(), /Обнаружен посторонний мод: injected-cheat\.jar/);
  } finally {
    guard.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('mod integrity guard: allows allowedGeneratedDirectories after runtime starts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'guard-runtime-dir-'));
  const modsRoot = join(root, 'mods');
  await mkdir(modsRoot, { recursive: true });

  const legit = Buffer.from('legit-game-mod');
  await writeFile(join(modsRoot, 'legit.jar'), legit);

  const expected = new Map([
    ['legit.jar', { name: 'legit.jar', size: legit.length, sha256: sha256(legit) }],
  ]);

  const guard = createModIntegrityGuard({
    modsRoot,
    expectedMods: expected,
    allowedGeneratedDirectories: ['.connector', '.cache'],
  });

  try {
    await guard.assertClean();
    guard.markRuntimeStarted();

    // Loader generates .connector directory
    await mkdir(join(modsRoot, '.connector'), { recursive: true });

    // Should NOT throw because .connector is in allowedGeneratedDirectories after runtime started
    await guard.assertClean();
  } finally {
    guard.close();
    await rm(root, { recursive: true, force: true });
  }
});
