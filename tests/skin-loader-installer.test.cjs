'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdtemp, readFile, readdir, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const {
  selectSkinLoaderFile, ensureSkinLoader,
} = require('../src/main/skin-loader-installer.cjs');

const JAR = Buffer.from([0x50, 0x4b, 0x03, 0x04, 8, 0, 0, 0, 0, 0, 10, 0]);
const URL = 'https://cdn.modrinth.com/data/example/versions/version/skinloader.jar';
function goodVersion(hash = createHash('sha512').update(JAR).digest('hex')) {
  return {
    version_type: 'release', loaders: ['neoforge'], game_versions: ['1.21.1'],
    files: [{ primary: true, filename: 'CustomSkinLoader.jar', url: URL,
      size: JAR.length, hashes: { sha512: hash } }],
  };
}

test('skin mod metadata restricted to official CDN and correct Minecraft version', () => {
  assert.equal(selectSkinLoaderFile([goodVersion()]).url, URL);
  assert.throws(() => selectSkinLoaderFile([{ ...goodVersion(), loaders: ['fabric'] }]));
  assert.throws(() => selectSkinLoaderFile([{ ...goodVersion(),
    files: [{ ...goodVersion().files[0], url: 'https://example.net/malware.jar' }] }]));
  assert.throws(() => selectSkinLoaderFile([{ ...goodVersion(),
    files: [{ ...goodVersion().files[0], hashes: { sha512: 'wrong' } }] }]));
});

test('downloads a verified skin loader only once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'events-skin-mod-'));
  let calls = 0;
  const fetcher = async (url) => {
    calls++;
    return url.startsWith('https://api.modrinth.com')
      ? Response.json([goodVersion()])
      : new Response(JAR);
  };
  try {
    assert.equal(await ensureSkinLoader(root, () => {}, fetcher), true);
    const files = await readdir(join(root, 'mods'));
    assert.equal(files.length, 1);
    assert.deepEqual(await readFile(join(root, 'mods', files[0])), JAR);
    assert.equal(await ensureSkinLoader(root, () => {}, fetcher), false);
    assert.equal(calls, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses mismatched mod SHA-512 without leaving a jar file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'events-skin-mod-'));
  const fetcher = async (url) => url.startsWith('https://api.modrinth.com')
    ? Response.json([goodVersion('f'.repeat(128))])
    : new Response(JAR);
  try {
    await assert.rejects(ensureSkinLoader(root, () => {}, fetcher), /Контрольная сумма/);
    assert.equal((await readdir(join(root, 'mods'))).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
