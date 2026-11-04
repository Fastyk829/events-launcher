'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { crc32 } = require('node:zlib');
const { loadDefaultSteve, STEVE_ENTRY } = require('../src/main/default-steve.cjs');

function minimalZip(name, contents) {
  const path = Buffer.from(name);
  const crc = crc32(contents);
  const local = Buffer.alloc(30 + path.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(contents.length, 18);
  local.writeUInt32LE(contents.length, 22);
  local.writeUInt16LE(path.length, 26);
  path.copy(local, 30);

  const central = Buffer.alloc(46 + path.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(contents.length, 20);
  central.writeUInt32LE(contents.length, 24);
  central.writeUInt16LE(path.length, 28);
  path.copy(central, 46);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length + contents.length, 16);
  return Buffer.concat([local, contents, central, eocd]);
}

function sampleSkin(width = 64, height = 64) {
  const image = Buffer.alloc(100);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(image);
  image.writeUInt32BE(13, 8);
  image.write('IHDR', 12);
  image.writeUInt32BE(width, 16);
  image.writeUInt32BE(height, 20);
  return image;
}

test('Steve preview is read only from an installed Minecraft client jar', async () => {
  const root = await mkdtemp(join(tmpdir(), 'events-steve-'));
  try {
    assert.equal(await loadDefaultSteve(root), null);
    const versionDir = join(root, 'versions', '1.21.1');
    await mkdir(versionDir, { recursive: true });
    const skin = sampleSkin();
    await writeFile(join(versionDir, '1.21.1.jar'), minimalZip(STEVE_ENTRY, skin));
    assert.equal(await loadDefaultSteve(root), 'data:image/png;base64,' + skin.toString('base64'));
    await writeFile(join(versionDir, '1.21.1.jar'), minimalZip(STEVE_ENTRY, sampleSkin(32, 64)));
    await assert.rejects(loadDefaultSteve(root), /неподдерживаемую/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('untrusted version names are never interpreted as paths', async () => {
  await assert.rejects(loadDefaultSteve(tmpdir(), '../other'), /Invalid Minecraft version/);
});
