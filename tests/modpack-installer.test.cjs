'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  configuredModpack, googleDriveFileId, trustedHost,
  validateZipPath, resolveSource, downloadArchive,
} = require('../src/main/modpack-installer.cjs');

test('unconfigured modpack is not advertised as ready', () => {
  assert.equal(configuredModpack(), false);
});

test('accepts public Google Drive file links only', () => {
  assert.equal(
    googleDriveFileId('https://drive.google.com/file/d/1AbcDEFghiJkLmNOPqrsTuvWxyz12345/view?usp=sharing'),
    '1AbcDEFghiJkLmNOPqrsTuvWxyz12345',
  );
  assert.throws(() => googleDriveFileId('https://example.org/file/d/1AbcDEFghiJkLmNOPqrsTuvWxyz12345'));
  assert.throws(() => googleDriveFileId('http://drive.google.com/file/d/1AbcDEFghiJkLmNOPqrsTuvWxyz12345'));
});

test('only trusted storage download hosts are accepted', () => {
  assert.equal(trustedHost('downloader.disk.yandex.ru', 'yandex-disk'), true);
  assert.equal(trustedHost('fake-yandex.ru.evil.net', 'yandex-disk'), false);
  assert.equal(trustedHost('drive.usercontent.google.com', 'google-drive'), true);
  assert.equal(trustedHost('127.0.0.1', 'google-drive'), false);
});

test('ZIP entries are restricted to game directories and have no traversal', () => {
  assert.deepEqual(validateZipPath('mods/example.jar'), { relativePath: 'mods/example.jar', directory: false });
  assert.deepEqual(validateZipPath('config/'), { relativePath: 'config', directory: true });
  for (const path of ['../secret.txt', 'mods/../../secret.txt', '/mods/evil.jar',
    'C:/mods/evil.jar', 'mods\\evil.jar', 'game.exe', 'mods/./x.jar']) {
    assert.throws(() => validateZipPath(path));
  }
});

test('Yandex public endpoint resolves a HTTPS download URL', async () => {
  const requests = [];
  const result = await resolveSource({
    provider: 'yandex-disk', publicUrl: 'https://disk.yandex.ru/d/ExamplePublicShare',
  }, async (url) => {
    requests.push(url);
    return new Response(JSON.stringify({ href: 'https://downloader.disk.yandex.ru/disk/example.zip' }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  });
  assert.equal(result.provider, 'yandex-disk');
  assert.equal(new URL(result.url).hostname, 'downloader.disk.yandex.ru');
  assert.equal(new URL(requests[0]).searchParams.get('public_key'), 'https://disk.yandex.ru/d/ExamplePublicShare');
});

test('prioritizes Yandex Disk and switches to Google Drive if Yandex fails', async () => {
  const { mkdtemp, rm, readFile, readdir } = require('node:fs/promises');
  const { join } = require('node:path');
  const { tmpdir } = require('node:os');
  const { createHash } = require('node:crypto');
  const root = await mkdtemp(join(tmpdir(), 'events-pack-fallback-'));
  const bytes = Buffer.from('verified test archive');
  const manifest = { version: 'test', sha256: createHash('sha256').update(bytes).digest('hex'), sources: [
    { provider: 'google-drive', publicUrl: 'https://drive.google.com/file/d/1234567890abcdef/view' },
    { provider: 'yandex-disk', publicUrl: 'https://disk.yandex.ru/d/test' },
  ] };
  const requests = [], notices = [];
  let yandexAborted = false;
  try {
    const file = await downloadArchive(root, message => notices.push(message), async (url, { signal }) => {
      requests.push(new URL(url).hostname);
      if (url.includes('cloud-api.yandex.net')) {
        return new Response(JSON.stringify({ href: 'https://downloader.disk.yandex.ru/test.zip' }));
      }
      if (url.includes('downloader.disk.yandex.ru')) {
        return new Response(new ReadableStream({
          start() {
            signal.addEventListener('abort', () => { yandexAborted = true; }, { once: true });
          },
          pull() { return new Promise(() => {}); },
          cancel() { return new Promise(() => {}); },
        }));
      }
      if (url.includes('drive.usercontent.google.com')) return new Response(bytes);
      return new Response(bytes);
    }, manifest, 100);
    assert.equal(yandexAborted, true);
    assert.deepEqual(requests, ['cloud-api.yandex.net', 'downloader.disk.yandex.ru', 'drive.usercontent.google.com']);
    assert.deepEqual(await readFile(file), bytes);
    assert.ok(notices.includes('Переключаемся на Google Drive…'));
    assert.equal((await readdir(join(root, 'downloads'))).filter(x => x.endsWith('.part')).length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('downloads directly from Yandex Disk when available without touching Google Drive', async () => {
  const { mkdtemp, rm, readFile, readdir } = require('node:fs/promises');
  const { join } = require('node:path');
  const { tmpdir } = require('node:os');
  const { createHash } = require('node:crypto');
  const root = await mkdtemp(join(tmpdir(), 'events-pack-yandex-'));
  const bytes = Buffer.from('verified test archive');
  const manifest = { version: 'test', sha256: createHash('sha256').update(bytes).digest('hex'), sources: [
    { provider: 'google-drive', publicUrl: 'https://drive.google.com/file/d/1234567890abcdef/view' },
    { provider: 'yandex-disk', publicUrl: 'https://disk.yandex.ru/d/test' },
  ] };
  const requests = [], notices = [];
  try {
    const file = await downloadArchive(root, message => notices.push(message), async (url) => {
      requests.push(new URL(url).hostname);
      if (url.includes('cloud-api.yandex.net')) {
        return new Response(JSON.stringify({ href: 'https://downloader.disk.yandex.ru/test.zip' }));
      }
      return new Response(bytes);
    }, manifest, 100);
    assert.deepEqual(requests, ['cloud-api.yandex.net', 'downloader.disk.yandex.ru']);
    assert.deepEqual(await readFile(file), bytes);
    assert.ok(!requests.includes('drive.usercontent.google.com'));
    assert.ok(notices.some(n => n.includes('Яндекс Диска')));
    assert.equal((await readdir(join(root, 'downloads'))).filter(x => x.endsWith('.part')).length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
