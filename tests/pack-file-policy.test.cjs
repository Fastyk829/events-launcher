'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, readFile, writeFile, readdir, rm } = require('node:fs/promises');
const { join, dirname } = require('node:path');
const { tmpdir } = require('node:os');
const { applyStagedModpack, validateZipPath, forceConfigPaths } =
  require('../src/main/modpack-installer.cjs');

async function write(root, path, value) {
  const full = join(root, ...path.split('/'));
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, value);
}
async function read(root, path) {
  return readFile(join(root, ...path.split('/')), 'utf8');
}

test('options.txt and config are installed once and kept across modpack releases', async () => {
  const base = await mkdtemp(join(tmpdir(), 'events-pack-policy-'));
  const instance = join(base, 'instance');
  const first = join(base, 'first'), second = join(base, 'second');
  const oldPaths = ['options.txt', 'config/player.toml', 'config/removed.toml', 'mods/a.jar'];
  const newPaths = ['options.txt', 'config/player.toml', 'config/added.toml', 'mods/b.jar'];
  const onProgress = () => undefined;
  try {
    await write(first, 'options.txt', 'default video settings');
    await write(first, 'config/player.toml', 'graphics=fast');
    await write(first, 'config/removed.toml', 'keep-me=true');
    await write(first, 'mods/a.jar', 'oldmod');
    await applyStagedModpack(first, instance, oldPaths, [], {}, onProgress);
    await write(instance, 'options.txt', 'user video settings');
    await write(instance, 'config/player.toml', 'graphics=fancy');

    await write(second, 'options.txt', 'new default settings');
    await write(second, 'config/player.toml', 'graphics=off');
    await write(second, 'config/added.toml', 'feature=true');
    await write(second, 'mods/b.jar', 'newmod');
    const result = await applyStagedModpack(second, instance, newPaths, oldPaths, {}, onProgress);
    assert.equal(await read(instance, 'options.txt'), 'user video settings');
    assert.equal(await read(instance, 'config/player.toml'), 'graphics=fancy');
    assert.equal(await read(instance, 'config/removed.toml'), 'keep-me=true');
    assert.equal(await read(instance, 'config/added.toml'), 'feature=true');
    assert.equal(await read(instance, 'mods/b.jar'), 'newmod');
    await assert.rejects(read(instance, 'mods/a.jar'), { code: 'ENOENT' });
    assert.equal(result.kept, 2);
    assert.equal(result.replaced, 0);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('publisher can force a targeted config update without creating backups', async () => {
  const base = await mkdtemp(join(tmpdir(), 'events-pack-force-'));
  const instance = join(base, 'instance'), next = join(base, 'next');
  try {
    await write(instance, 'options.txt', 'player options');
    await write(instance, 'config/server.toml', 'player_customization=true');
    await write(instance, 'config/ui.toml', 'player_ui=true');
    await write(next, 'options.txt', 'new options');
    await write(next, 'config/server.toml', 'required=true');
    await write(next, 'config/ui.toml', 'new_ui=true');
    const manifest = { forceConfigFiles: ['config/server.toml'] };
    const paths = ['options.txt', 'config/server.toml', 'config/ui.toml'];
    const stats = await applyStagedModpack(next, instance, paths, paths, manifest, () => {});
    assert.equal(await read(instance, 'options.txt'), 'player options');
    assert.equal(await read(instance, 'config/server.toml'), 'required=true');
    assert.equal(await read(instance, 'config/ui.toml'), 'player_ui=true');
    assert.equal(stats.replaced, 1);
    assert.equal(stats.kept, 2);
    assert.equal(Object.hasOwn(stats, 'backupFolder'), false);
    await assert.rejects(readdir(join(instance, '.events', 'config-backups')), { code: 'ENOENT' });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('force cannot overwrite options.txt or write a non-existent config file', async () => {
  assert.deepEqual(validateZipPath('options.txt'),
    { relativePath: 'options.txt', directory: false });
  assert.throws(() => validateZipPath('options.txt/'));
  assert.throws(() => validateZipPath('options.txt/evil.txt'));
  for (const path of ['options.txt', 'mods/a.jar', 'config/../evil.toml',
    'defaultconfigs/', 'config/evil\\name.toml']) {
    assert.throws(() => forceConfigPaths({ forceConfigFiles: [path] }));
  }
  const base = await mkdtemp(join(tmpdir(), 'events-pack-missing-'));
  try {
    await assert.rejects(
      applyStagedModpack(base, join(base, 'game'), ['mods/a.jar'], [],
        { forceConfigFiles: ['config/required.toml'] }, () => {}),
      /отсутствует в ZIP/,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
