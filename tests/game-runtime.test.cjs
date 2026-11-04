'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

// Unit tests for deterministic parts of the runtime; main process is exercised
// by Windows smoke tests after npm install.
const { EventGameRuntime, safeNickname, offlineUuid, javaAsset, neoforgeVersionId } = require('../src/main/game-runtime.cjs');

test('validates offline nicknames before Java launch', () => {
  assert.equal(safeNickname('Player_123'), 'Player_123');
  for (const bad of ['', 'a', 'has space', 'a'.repeat(17), 'a;rm -rf']) {
    assert.throws(() => safeNickname(bad));
  }
});
test('offline UUID is deterministic and version three', () => {
  assert.equal(offlineUuid('Steve'), offlineUuid('Steve'));
  assert.equal(offlineUuid('Steve').length, 32);
  assert.equal(offlineUuid('Steve')[12], '3');
});
test('only NeoForge 21.1.265 is considered compatible', () => {
  assert.ok(neoforgeVersionId('neoforge-21.1.265'));
  assert.ok(!neoforgeVersionId('neoforge-21.1.264'));
  assert.ok(!neoforgeVersionId('fabric-loader-0.16.0-1.21.1'));
});
test('rejects unexpected Java artifacts and hostnames', () => {
  const pkg = { binary: { package: {
    name: 'OpenJDK21U-jre_x64_windows_hotspot_21.0.9_10.zip',
    link: 'https://github.com/adoptium/temurin21-binaries/releases/download/v21/file.zip',
    checksum: 'a'.repeat(64), size: 10_000,
  } } };
  assert.equal(javaAsset([pkg]).size, 10_000);
  assert.throws(() => javaAsset([{binary:{package:{...pkg.binary.package,link:'https://evil.example/java.zip'}}}]));
});

test('EventGameRuntime.getExpectedMods reads modFiles and CustomSkinLoader', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises');
  const { join } = require('node:path');
  const { tmpdir } = require('node:os');
  const tempDir = await mkdtemp(join(tmpdir(), 'game-runtime-mods-'));
  try {
    const runtime = new EventGameRuntime(() => {});
    runtime.instanceRoot = tempDir;

    const metaDir = join(tempDir, '.events');
    const modsDir = join(tempDir, 'mods');
    await mkdir(metaDir, { recursive: true });
    await mkdir(modsDir, { recursive: true });

    await writeFile(join(metaDir, 'pack.json'), JSON.stringify({
      version: '1.0.0',
      sha256: 'a'.repeat(64),
      files: ['mods/mod-a.jar'],
      modFiles: [
        { path: 'mods/mod-a.jar', name: 'mod-a.jar', size: 100, sha256: 'b'.repeat(64) },
      ],
    }));

    // Add CustomSkinLoader to mods
    await writeFile(join(modsDir, 'CustomSkinLoader-Events.jar'), 'skin-loader-content');

    const expected = await runtime.getExpectedMods();
    assert.equal(expected.has('mod-a.jar'), true);
    assert.equal(expected.get('mod-a.jar').size, 100);
    assert.equal(expected.has('customskinloader-events.jar'), true);
    assert.equal(expected.get('customskinloader-events.jar').size, 'skin-loader-content'.length);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
