'use strict';

// Official client-only CustomSkinLoader for Minecraft 1.21.1 + NeoForge.
// Download from Modrinth; never execute or install a jar without SHA-512.
const { createHash, randomUUID } = require('node:crypto');
const { createWriteStream } = require('node:fs');
const { lstat, mkdir, readdir, rename, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { DownloadProgressMeter } = require('./download-progress.cjs');

const API = new URL('https://api.modrinth.com/v2/project/customskinloader/version');
API.searchParams.set('loaders', JSON.stringify(['neoforge']));
API.searchParams.set('game_versions', JSON.stringify(['1.21.1']));
const MAX_METADATA_BYTES = 768 * 1024;
const MAX_JAR_BYTES = 8 * 1024 * 1024;

function selectSkinLoaderFile(versions) {
  if (!Array.isArray(versions)) throw new Error('Modrinth вернул неверные метаданные скинов');
  for (const version of versions) {
    if (!version || version.version_type !== 'release' ||
        !version.loaders?.includes('neoforge') ||
        !version.game_versions?.includes('1.21.1')) continue;
    const file = version.files?.find((x) =>
      x.primary && typeof x.filename === 'string' && x.filename.endsWith('.jar')) ||
      version.files?.find((x) => x.filename?.endsWith('.jar'));
    if (!file || !Number.isSafeInteger(file.size) ||
        file.size <= 0 || file.size > MAX_JAR_BYTES ||
        !/^[a-f0-9]{128}$/.test(file.hashes?.sha512)) continue;
    let url;
    try { url = new URL(file.url); } catch { continue; }
    if (url.protocol !== 'https:' || url.hostname !== 'cdn.modrinth.com' ||
        url.username || url.password || url.port) continue;
    return { url: url.toString(), hash: file.hashes.sha512, size: file.size };
  }
  throw new Error('Не найден CustomSkinLoader для NeoForge 1.21.1');
}

async function limitedJson(response, limit = MAX_METADATA_BYTES) {
  if (!response.ok || !response.body) throw new Error('Modrinth: HTTP ' + response.status);
  const chunks = [];
  let n = 0;
  for await (const chunk of Readable.fromWeb(response.body)) {
    n += chunk.length;
    if (n > limit) throw new Error('Метаданные Modrinth слишком большие');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function ensureSkinLoader(gameDir, onProgress = () => {}, fetcher = fetch) {
  const mods = join(gameDir, 'mods');
  await mkdir(mods, { recursive: true });
  const existing = await readdir(mods);
  if (existing.some((name) => /^customskinloader[-_.].*\.jar$/i.test(name))) return false;
  onProgress('Загружаем компонент локальных скинов…');
  const meta = await fetcher(API.toString(), {
    redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: { 'User-Agent': 'EventsLauncher/0.1', Accept: 'application/json' },
  });
  const asset = selectSkinLoaderFile(await limitedJson(meta));
  const dest = join(mods, 'CustomSkinLoader-Events.jar');
  const present = await lstat(dest).catch((e) => {
    if (e.code === 'ENOENT') return null;
    throw e;
  });
  if (present) throw new Error('Файл компонента скинов уже занят');
  const temp = dest + '.' + randomUUID() + '.part';
  try {
    const res = await fetcher(asset.url, {
      redirect: 'error', signal: AbortSignal.timeout(90_000),
      headers: { 'User-Agent': 'EventsLauncher/0.1' },
    });
    if (!res.ok || !res.body) throw new Error('Не удалось скачать CustomSkinLoader: HTTP ' + res.status);
    const meter = new DownloadProgressMeter({
      label: 'Скачиваем CustomSkinLoader',
      total: asset.size,
      onProgress,
    });
    meter.emit();
    const hash = createHash('sha512');
    let total = 0, header = Buffer.alloc(0);
    const checksum = new Transform({
      transform(chunk, _enc, callback) {
        total += chunk.length;
        if (total > MAX_JAR_BYTES) return callback(new Error('Слишком большой файл мода скинов'));
        if (header.length < 4) header = Buffer.concat([header, chunk]).subarray(0, 4);
        hash.update(chunk);
        meter.update(total, asset.size);
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), checksum, createWriteStream(temp, { flags: 'wx' }));
    if (total !== asset.size || hash.digest('hex') !== asset.hash ||
        !header.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
      throw new Error('Контрольная сумма или формат компонента скинов не совпадают');
    }
    await rename(temp, dest);
    return true;
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

module.exports = { selectSkinLoaderFile, ensureSkinLoader };
