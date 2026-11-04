'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fetchReleasedModpack, validateManifest, trustedGithubAsset } =
  require('../src/main/release-manifest.cjs');

const fixture = {
  schemaVersion: 1, eventId: 'project-war', version: '1.0.2',
  sha256: 'a'.repeat(64), sources: [
    { provider: 'yandex-disk', publicUrl: 'https://disk.yandex.ru/d/TestLink' },
  ],
};
const assetUrl = 'https://github.com/Fastyk829/events-launcher/releases/download/project-war-modpack/project-war.modpack.json';

test('remote release manifest validates exact event and sources', () => {
  assert.deepEqual(validateManifest(fixture).version, '1.0.2');
  assert.throws(() => validateManifest({ ...fixture, eventId: 'other' }));
  assert.throws(() => validateManifest({ ...fixture, sha256: 'bad' }));
  assert.throws(() => validateManifest({ ...fixture, sources: [{
    provider: 'yandex-disk', publicUrl: 'https://evil.test/a.zip',
  }] }));
  assert.equal(trustedGithubAsset('github.com.evil.test'), false);
});
test('404 published release means no modpack is announced yet', async () => {
  assert.equal(await fetchReleasedModpack(async () => new Response('', { status: 404 })), null);
});
test('rejects redirection from GitHub assets to an untrusted domain', async () => {
  let count = 0;
  const fetcher = async () => {
    count++;
    if (count === 1) return Response.json({
      tag_name: 'project-war-modpack', draft: false, prerelease: true,
      assets: [{ name: 'project-war.modpack.json', state: 'uploaded', browser_download_url: assetUrl }],
    });
    return new Response(null, { status: 302, headers: { location: 'https://evil.test/manifest.json' } });
  };
  await assert.rejects(fetchReleasedModpack(fetcher), /недоверенный адрес/);
});
test('reads verified JSON metadata from a GitHub release asset', async () => {
  let count = 0;
  const fetcher = async () => {
    count++;
    if (count === 1) return Response.json({
      tag_name: 'project-war-modpack', draft: false, prerelease: true,
      assets: [{ name: 'project-war.modpack.json', state: 'uploaded', browser_download_url: assetUrl }],
    });
    return Response.json(fixture);
  };
  const result = await fetchReleasedModpack(fetcher);
  assert.equal(result.version, '1.0.2');
});

test('publisher-only forceConfigFiles is validated and preserved', () => {
  const manifest = validateManifest({
    ...fixture, forceConfigFiles: ['config/server.toml', 'defaultconfigs/world.toml'],
  });
  assert.deepEqual(manifest.forceConfigFiles, ['config/server.toml', 'defaultconfigs/world.toml']);
  for (const path of ['options.txt', 'mods/weapon.jar', 'config/../../windows.txt',
    'config\\server.toml', '/config/server.toml', 'config/']) {
    assert.throws(() => validateManifest({ ...fixture, forceConfigFiles: [path] }));
  }
  assert.throws(() => validateManifest({
    ...fixture, forceConfigFiles: ['config/HI.toml', 'config/hi.toml'],
  }));
});
