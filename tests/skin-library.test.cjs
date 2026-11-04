'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, readFile, rm, readdir } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { SkinLibrary, validateSkinPng } = require('../src/main/skin-library.cjs');

function samplePng(width = 64, height = 64) {
  // The real Electron import also invokes its native PNG decoder. These tests
  // exercise dimension/header checks and the library's file policy.
  const buf = Buffer.alloc(80);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buf);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf[24] = 8; buf[25] = 6;
  return buf;
}

test('PNG headers must be Minecraft sized and a supported format', () => {
  assert.deepEqual(validateSkinPng(samplePng()), { width: 64, height: 64 });
  assert.deepEqual(validateSkinPng(samplePng(64, 32)), { width: 64, height: 32 });
  assert.throws(() => validateSkinPng(samplePng(192, 192)), /PNG/);
  assert.throws(() => validateSkinPng(Buffer.alloc(80)), /PNG/);
});

test('normalizes decoded palette PNG before storing and reports unsupported dimensions', async () => {
  const base = await mkdtemp(join(tmpdir(), 'events-skins-palette-'));
  try {
    const source = join(base, 'palette.png');
    const indexed = samplePng(); indexed[25] = 3;
    await writeFile(source, indexed);
    const lib = new SkinLibrary(base);
    const imported = await lib.importFile(source, () => samplePng());
    const saved = await readFile(join(base, 'skins', imported.activeId + '.png'));
    assert.equal(saved[25], 6);
    assert.throws(() => validateSkinPng(samplePng(512, 512)), /512×512/);
    await assert.rejects(lib.importFile(source, () => false), /повреждён/);
    await assert.rejects(lib.importFile(source, () => indexed), /RGB/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('import, select, update model, sync to nickname, and delete a local skin', async () => {
  const base = await mkdtemp(join(tmpdir(), 'events-skins-'));
  const lib = new SkinLibrary(base);
  const source = join(base, 'My Skin.png');
  const game = join(base, 'instance');
  try {
    await writeFile(source, samplePng());
    let snapshot = await lib.importFile(source, () => true);
    assert.equal(snapshot.skins.length, 1);
    assert.equal(snapshot.skins[0].name, 'My Skin');
    const id = snapshot.skins[0].id;
    assert.equal(snapshot.activeId, id);
    snapshot = await lib.setModel(id, 'slim');
    assert.equal(snapshot.skins[0].model, 'slim');
    assert.equal(await lib.syncForLaunch(game, 'Player123'), true);
    const installed = join(game, 'CustomSkinLoader', 'LocalSkin', 'skins', 'Player123.png');
    assert.deepEqual(await readFile(installed), samplePng());
    const config = JSON.parse(await readFile(join(game, 'CustomSkinLoader', 'CustomSkinLoader.json'), 'utf8'));
    assert.equal(config.loadlist[0].model, 'slim');
    await lib.syncForLaunch(game, 'Steve123');
    await assert.rejects(readFile(installed), { code: 'ENOENT' });
    await lib.select(null);
    await lib.syncForLaunch(game, 'Steve123');
    await assert.rejects(readFile(join(game, 'CustomSkinLoader', 'LocalSkin', 'skins', 'Steve123.png')),
      { code: 'ENOENT' });
    await lib.remove(id);
    assert.equal((await lib.list()).skins.length, 0);
    await assert.rejects(readFile(join(base, 'skins', id + '.png')), { code: 'ENOENT' });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('skin sync does not delete a locally modified file and rejects unknown selection', async () => {
  const base = await mkdtemp(join(tmpdir(), 'events-skins-'));
  const lib = new SkinLibrary(base);
  const game = join(base, 'instance');
  try {
    assert.equal(await lib.syncForLaunch(game, 'Steve123'), false);
    await assert.rejects(lib.select('abc'), /не найден/);
    const source = join(base, 'skin.png');
    await writeFile(source, samplePng());
    await lib.importFile(source, () => true);
    await lib.syncForLaunch(game, 'Player123');
    const installed = join(game, 'CustomSkinLoader', 'LocalSkin', 'skins', 'Player123.png');
    await writeFile(installed, 'user edit');
    await lib.select(null);
    await lib.syncForLaunch(game, 'Player123');
    assert.equal((await readFile(installed, 'utf8')), 'user edit');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
