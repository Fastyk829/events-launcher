'use strict';
const { test } = require('node:test');
const { mkdtemp, readdir, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const config = require('../game-runtime.json');
const { installerFileName, installerSource, downloadNeoForgeInstaller } = require('../src/main/neoforge-installer.cjs');

test('one pinned NeoForge 1.21.1 runtime', () => {
  assert.equal(config.minecraftVersion, '1.21.1');
  assert.equal(config.loader, 'neoforge');
  assert.equal(config.javaMajor, 21);
  assert.equal(installerFileName(), 'neoforge-21.1.265-installer.jar');
});

test('official release artifact is pinned with a SHA-256 checksum', () => {
  const { url, sha256 } = installerSource();
  assert.equal(new URL(url).hostname, 'maven.neoforged.net');
  assert.equal(new URL(url).pathname, '/releases/net/neoforged/neoforge/21.1.265/neoforge-21.1.265-installer.jar');
  assert.match(sha256, /^[a-f0-9]{64}$/);
});

test('rejects an installer whose SHA-256 does not match the pinned release', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'events-neoforge-test-'));
  try {
    await assert.rejects(
      downloadNeoForgeInstaller(directory, async () => new Response('invalid installer')),
      /neoforge_download_checksum_mismatch/,
    );
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('refuses redirects and leaves no unverified installer in the cache', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'events-neoforge-redirect-'));
  try {
    await assert.rejects(downloadNeoForgeInstaller(directory, async (_url, options) => {
      assert.equal(options.redirect, 'manual');
      return new Response(null, { status: 302, headers: { location: 'https://example.com/installer.jar' } });
    }), /neoforge_download_failed:302/);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
