'use strict';

// Standalone NeoForge installer fetcher: does not run downloaded executable code.
// The hash and URL are pinned in game-runtime.json and must be reviewed on updates.
const { createHash, randomUUID } = require('node:crypto');
const { createReadStream, createWriteStream } = require('node:fs');
const { mkdir, lstat, rename, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const runtime = require('../../game-runtime.json');
const { withMinecraftDownloads } = require('./minecraft-downloads.cjs');

const MAX_INSTALLER_BYTES = 32 * 1024 * 1024;

function installerFileName() {
  if (runtime.minecraftVersion !== '1.21.1' || runtime.loader !== 'neoforge'
    || runtime.javaMajor !== 21 || !/^21\.1\.\d+$/.test(runtime.loaderVersion)) {
    throw new Error('unsupported_game_runtime');
  }
  return `neoforge-${runtime.loaderVersion}-installer.jar`;
}

function installerSource() {
  const url = new URL(runtime.installer.url);
  const expectedPath = `/releases/net/neoforged/neoforge/${runtime.loaderVersion}/${installerFileName()}`;
  if (url.protocol !== 'https:' || url.host !== 'maven.neoforged.net'
    || url.pathname !== expectedPath || url.search || url.hash || url.username || url.password) {
    throw new Error('untrusted_neoforge_source');
  }
  if (!/^[a-f0-9]{64}$/.test(runtime.installer.sha256)) {
    throw new Error('invalid_neoforge_checksum');
  }
  return { url: url.toString(), sha256: runtime.installer.sha256 };
}

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}

async function downloadNeoForgeInstaller(directory, fetcher, onRetry = () => {}) {
  // Reopen a fresh temporary file for each attempt; only a complete, verified
  // installer can be moved into the cache. Preserve manual redirects below.
  if (!fetcher) {
    // Chromium uses Windows network/proxy settings and its own connection
    // fallback; Node's direct TLS route may time out on this Maven CDN.
    const { net } = require('electron');
    return withMinecraftDownloads(options => downloadNeoForgeInstaller(directory,
      net ? net.fetch.bind(net) : options.fetch), onRetry);
  }
  const { url, sha256 } = installerSource();
  await mkdir(directory, { recursive: true });
  const target = join(directory, installerFileName());
  try {
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('installer_target_not_regular_file');
    if (await sha256File(target) === sha256) return target;
    await rm(target);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const temp = `${target}.${randomUUID()}.part`;
  try {
    const response = await fetcher(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok || !response.body || response.status !== 200) {
      throw new Error(`neoforge_download_failed:${response.status}`);
    }
    let received = 0;
    const hash = createHash('sha256');
    const check = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > MAX_INSTALLER_BYTES) {
          callback(new Error('neoforge_download_too_large'));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), check, createWriteStream(temp, { flags: 'wx' }));
    if (hash.digest('hex') !== sha256) throw new Error('neoforge_download_checksum_mismatch');
    await rename(temp, target);
    return target;
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

module.exports = { installerFileName, installerSource, downloadNeoForgeInstaller };
