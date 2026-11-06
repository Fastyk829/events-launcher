'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { pipeline } = require('node:stream/promises');
const { prepareNeoForgeLibraries, libraryArtifact } = require('../src/main/neoforge-libraries.cjs');
test('NeoForge libraries retry corrupted downloads, validate cache and skip embedded artifacts', async () => {
 const root = await mkdtemp(join(tmpdir(), 'neo-libs-'));
 try {
  const content = Buffer.from('verified library');
  const artifact = { url: 'https://maven.neoforged.net/releases/test.jar', path: 'net/test/1/test.jar', size: content.length, sha1: createHash('sha1').update(content).digest('hex') };
  const library = { name: 'net:test:1', downloads: { artifact } };
  assert.throws(() => libraryArtifact({ ...library, downloads: { artifact: { ...artifact, path: '../escape.jar' } } }));
  assert.throws(() => libraryArtifact({ ...library, downloads: { artifact: { ...artifact, url: 'https://evil.example/test.jar' } } }));
  const zip = new (require('yazl').ZipFile)();
  zip.addBuffer(Buffer.from(JSON.stringify({ libraries: [library, { downloads: { artifact: { url: '' } } }] })), 'install_profile.json');
  zip.addBuffer(Buffer.from(JSON.stringify({ libraries: [library] })), 'version.json');
  zip.end();
  const installer = join(root, 'installer.jar');
  await pipeline(zip.outputStream, createWriteStream(installer));
  let calls = 0;
  const fetcher = async () => new Response(++calls === 1 ? 'broken' : content);
  await prepareNeoForgeLibraries(installer, root, () => {}, [fetcher]);
  assert.equal(calls, 2);
  assert.deepEqual(await readFile(join(root, 'libraries', artifact.path)), content);
  await prepareNeoForgeLibraries(installer, root, () => {}, [fetcher]);
  assert.equal(calls, 2);
 } finally { await rm(root, { recursive: true, force: true }); }
});
