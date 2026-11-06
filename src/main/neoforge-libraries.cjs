'use strict';
const yauzl = require('yauzl');
const { createHash, randomUUID } = require('node:crypto');
const { createReadStream, createWriteStream } = require('node:fs');
const { mkdir, rename, rm } = require('node:fs/promises');
const { join, dirname } = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { fetchWithIdleTimeout } = require('./storage-fetch.cjs');

function readLibraryProfiles(installer) {
  return new Promise((resolve, reject) => {
    yauzl.open(installer, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      const libraries = [];
      zip.on('error', reject);
      zip.on('end', () => resolve(libraries));
      zip.on('entry', entry => {
        if (!['install_profile.json', 'version.json'].includes(entry.fileName)) return zip.readEntry();
        if (entry.uncompressedSize > 4 * 1024 * 1024) { zip.close(); reject(new Error('Слишком большой профиль NeoForge')); return; }
        zip.openReadStream(entry, (error, stream) => {
          if (error) { zip.close(); reject(error); return; }
          const chunks = [];
          stream.on('data', chunk => chunks.push(chunk));
          stream.on('error', error => { zip.close(); reject(error); });
          stream.on('end', () => {
            try { libraries.push(...(JSON.parse(Buffer.concat(chunks).toString()).libraries || [])); zip.readEntry(); }
            catch (error) { zip.close(); reject(error); }
          });
        });
      });
      zip.readEntry();
    });
  });
}

function libraryArtifact(library) {
  const artifact = library.downloads?.artifact;
  if (!artifact?.url) return null; // Embedded installer artifacts have empty URLs.
  const url = new URL(artifact.url);
  if (url.protocol !== 'https:' || url.username || url.password ||
      !['maven.neoforged.net', 'libraries.minecraft.net', 'repo.maven.apache.org', 'repo1.maven.org', 'maven.minecraftforge.net'].includes(url.hostname) ||
      !/^[a-f0-9]{40}$/.test(artifact.sha1) || !Number.isSafeInteger(artifact.size) || artifact.size <= 0 || artifact.size > 128 * 1024 * 1024 ||
      !/^[A-Za-z0-9_./+-]+$/.test(artifact.path) || artifact.path.split('/').some(p => !p || p === '.' || p === '..')) {
    throw new Error('Некорректная библиотека NeoForge: ' + library.name);
  }
  return artifact;
}

async function validFile(path, artifact) {
  try {
    const hash = createHash('sha1');
    let size = 0;
    for await (const chunk of createReadStream(path)) { size += chunk.length; hash.update(chunk); }
    return size === artifact.size && hash.digest('hex') === artifact.sha1;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function prepareNeoForgeLibraries(installer, minecraftRoot, progress, fetchers) {
  if (!fetchers) {
    const { net } = require('electron');
    fetchers = net ? [net.fetch.bind(net), fetch] : [fetch];
  }
  const libraries = await readLibraryProfiles(installer);
  const seen = new Set();
  for (const library of libraries) {
    const artifact = libraryArtifact(library);
    if (!artifact || seen.has(artifact.path)) continue;
    seen.add(artifact.path);
    const target = join(minecraftRoot, 'libraries', ...artifact.path.split('/'));
    if (await validFile(target, artifact)) continue;
    await mkdir(dirname(target), { recursive: true });
    let failure;
    for (let attempt = 0; attempt < 3; attempt++) {
      const temp = target + '.' + randomUUID() + '.part';
      try {
        progress(`Скачиваем библиотеку NeoForge: ${library.name} (${attempt + 1}/3)…`, null);
        const response = await fetchWithIdleTimeout(fetchers[attempt % fetchers.length], artifact.url, {}, 60_000, 30_000);
        if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('HTTP ' + response.status); }
        let size = 0;
        const limit = new Transform({ transform(chunk, encoding, done) {
          size += chunk.length;
          done(size > artifact.size ? new Error('Неверный размер библиотеки NeoForge') : null, chunk);
        } });
        await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(temp, { flags: 'wx' }));
        if (!await validFile(temp, artifact)) throw new Error('Неверная контрольная сумма библиотеки NeoForge');
        await rm(target, { force: true });
        await rename(temp, target);
        failure = null;
        break;
      } catch (error) { failure = error; }
      finally { await rm(temp, { force: true }).catch(() => {}); }
    }
    if (failure) throw new Error('Не удалось скачать ' + library.name + ': ' + failure.message, { cause: failure });
  }
}
module.exports = { prepareNeoForgeLibraries, libraryArtifact };
