'use strict';

// Downloads a PUBLIC modpack ZIP from Yandex Disk or Google Drive.
// The archive is accepted only when its full SHA-256 matches the pinned value.
const { createHash, randomUUID } = require('node:crypto');
const { createReadStream, createWriteStream } = require('node:fs');
const { copyFile, lstat, mkdir, readFile, readdir, rm, rename, writeFile } = require('node:fs/promises');
const { basename, dirname, join, resolve, relative, sep } = require('node:path');
const { hashFile } = require('./mod-integrity-guard.cjs');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const yauzl = require('yauzl');
const config = require('../../project-war.modpack.json');
const { withMinecraftDownloads } = require('./minecraft-downloads.cjs');
const { fetchWithIdleTimeout } = require('./storage-fetch.cjs');
const { DownloadProgressMeter } = require('./download-progress.cjs');

const MAX_PACK_BYTES = 12 * 1024 * 1024 * 1024;
const MAX_FILES = 30_000;
const ALLOWED_ROOTS = new Set([
  'mods', 'config', 'defaultconfigs', 'resourcepacks', 'shaderpacks',
  'kubejs', 'scripts', 'datapacks',
]);

function configuredModpack(configured = config) {
  return typeof configured.version === 'string' && configured.version.length > 0 &&
    /^[0-9a-f]{64}$/.test(configured.sha256) &&
    Array.isArray(configured.sources) &&
    configured.sources.some((s) => s && ['yandex-disk', 'google-drive'].includes(s.provider) &&
      typeof s.publicUrl === 'string' && s.publicUrl.trim().length > 0);
}

function trustedHost(hostname, provider) {
  const host = hostname.toLowerCase();
  if (provider === 'yandex-disk') {
    return ['yandex.ru', 'yandex.net', 'yandex.com', 'yandexcloud.net', 'yandexcdn.net']
      .some((domain) => host === domain || host.endsWith('.' + domain)) || host === 'yadi.sk';
  }
  if (provider === 'google-drive') {
    return host === 'drive.google.com' || host === 'drive.usercontent.google.com' ||
      host === 'docs.google.com' || host.endsWith('.googleusercontent.com') ||
      host === 'googleusercontent.com';
  }
  return false;
}

function checkedUrl(raw, provider) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || !trustedHost(url.hostname, provider)) {
    throw new Error('Недоверенный адрес скачивания сборки: ' + url.hostname);
  }
  return url;
}

async function fetchTrusted(raw, provider, fetcher = fetch, startupDeadline = Infinity) {
  let url = checkedUrl(raw, provider);
  for (let i = 0; i < 7; i++) {
    const response = await fetchWithIdleTimeout(fetcher, url.toString(), {
      redirect: 'follow',
      headers: { 'user-agent': 'EventsLauncher/0.1' },
    }, provider === 'google-drive' ? 30_000 : 60_000,
    Math.max(1, Math.min(60_000, startupDeadline - Date.now())));
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('Диск вернул пустое перенаправление');
      url = checkedUrl(new URL(location, url).toString(), provider);
      continue;
    }
    if (response.url) {
      checkedUrl(response.url, provider);
    }
    return response;
  }
  throw new Error('Слишком много перенаправлений при скачивании сборки');
}

function googleDriveFileId(raw) {
  const u = checkedUrl(raw, 'google-drive');
  if (u.hostname !== 'drive.google.com') throw new Error('Укажи ссылку на файл Google Drive');
  const fromPath = /^\/file\/d\/([A-Za-z0-9_-]{10,128})(?:\/|$)/.exec(u.pathname)?.[1];
  const fromQuery = u.searchParams.get('id');
  const id = fromPath || fromQuery;
  if (!id || !/^[A-Za-z0-9_-]{10,128}$/.test(id)) {
    throw new Error('Ссылка Google Drive должна вести на публичный ZIP-файл');
  }
  return id;
}

async function resolveSource(source, fetcher = fetch, startupDeadline = Infinity) {
  if (source.provider === 'yandex-disk') {
    const share = checkedUrl(source.publicUrl, 'yandex-disk');
    if (!['disk.yandex.ru', 'disk.yandex.com', 'yadi.sk'].includes(share.hostname)) {
      throw new Error('Для Яндекс Диска нужна публичная ссылка на файл');
    }
    const api = new URL('https://cloud-api.yandex.net/v1/disk/public/resources/download');
    api.searchParams.set('public_key', share.toString());
    const response = await fetchTrusted(api.toString(), 'yandex-disk', fetcher, startupDeadline);
    if (!response.ok) throw new Error('Яндекс Диск: ссылка недоступна (HTTP ' + response.status + ')');
    const data = await response.json();
    if (!data || typeof data.href !== 'string') throw new Error('Яндекс Диск не вернул ссылку для скачивания');
    return { provider: source.provider, url: checkedUrl(data.href, source.provider).toString() };
  }
  if (source.provider === 'google-drive') {
    const id = googleDriveFileId(source.publicUrl);
    const url = new URL('https://drive.usercontent.google.com/download');
    url.searchParams.set('id', id);
    url.searchParams.set('export', 'download');
    url.searchParams.set('confirm', 't');
    return { provider: source.provider, url: url.toString() };
  }
  throw new Error('Неподдерживаемое облачное хранилище');
}

async function fileSha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function downloadArchive(root, onProgress, fetcher, manifest = config, startupMs = 8000) {
  if (!fetcher) {
    const { net } = require('electron');
    return withMinecraftDownloads(options => downloadArchive(root, onProgress,
      net ? net.fetch.bind(net) : options.fetch, manifest, startupMs), onProgress);
  }
  if (!configuredModpack(manifest)) throw new Error('Ссылка на сборку и SHA-256 ещё не настроены');
  const cache = join(root, 'downloads', 'project-war-' + manifest.sha256.slice(0, 16) + '.zip');
  await mkdir(dirname(cache), { recursive: true });
  const existing = await lstat(cache).catch(() => null);
  if (existing?.isFile() && !existing.isSymbolicLink() && existing.size <= MAX_PACK_BYTES &&
      await fileSha256(cache) === manifest.sha256) return cache;

  const failures = [];
  const causes = [];
  // Prioritize Yandex Disk first (fast direct download in CIS/Russia without throttling).
  // If Yandex is unavailable or fails, gracefully fall back to Google Drive.
  const sources = [...manifest.sources].sort((a, b) =>
    Number(a.provider !== 'yandex-disk') - Number(b.provider !== 'yandex-disk'));
  for (const source of sources) {
    if (!source?.publicUrl?.trim()) continue;
    const temp = cache + '.' + randomUUID() + '.part';
    try {
      const startupDeadline = Date.now() + startupMs;
      const targetName = source.provider === 'yandex-disk' ? 'Яндекс Диск' : 'Google Drive';
      const targetPrep = source.provider === 'yandex-disk' ? 'Яндекс Диску' : 'Google Drive';
      onProgress(failures.length
        ? `Переключаемся на ${targetName}…`
        : `Подключаемся к ${targetPrep}…`);
      const direct = await resolveSource(source, fetcher, startupDeadline);
      const response = await fetchTrusted(direct.url, direct.provider, fetcher, startupDeadline);
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error('Скачивание недоступно: HTTP ' + response.status);
      }
      const type = response.headers.get('content-type') || '';
      if (type.includes('text/html')) {
        await response.body.cancel();
        throw new Error('Диск вместо ZIP вернул страницу подтверждения доступа. Проверь публичную ссылку; для больших файлов удобнее Яндекс Диск.');
      }
      const contentLength = Number(response.headers.get('content-length')) || Number(manifest.size) || 0;
      const targetLabel = source.provider === 'yandex-disk' ? 'Яндекс Диска' : 'Google Drive';
      const meter = new DownloadProgressMeter({
        label: 'Скачиваем Project War с ' + targetLabel,
        total: contentLength,
        onProgress,
      });
      meter.emit();
      const hash = createHash('sha256');
      let size = 0;
      const meterStream = new Transform({
        transform(chunk, _encoding, callback) {
          size += chunk.length;
          if (size > MAX_PACK_BYTES) return callback(new Error('ZIP сборки превышает 12 ГБ'));
          hash.update(chunk);
          meter.update(size, contentLength);
          callback(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(response.body), meterStream, createWriteStream(temp, { flags: 'wx' }));
      if (size === 0 || hash.digest('hex') !== manifest.sha256) {
        throw new Error('SHA-256 архива не совпадает с ожидаемой суммой');
      }
      await rm(cache, { force: true });
      await rename(temp, cache);
      return cache;
    } catch (error) {
      causes.push(error);
      failures.push(source.provider + ': ' + (error?.message || String(error)));
    } finally {
      await rm(temp, { force: true }).catch(() => {});
    }
  }
  throw new Error('Не удалось скачать модпак. ' + failures.join(' | '), { cause: new AggregateError(causes) });
}

function validateZipPath(raw) {
  if (raw === 'options.txt') return { relativePath: 'options.txt', directory: false };
  if (typeof raw !== 'string' || !raw || raw.includes('\\') ||
      raw.startsWith('/') || raw.includes('\0') || /^[A-Za-z]:/.test(raw)) {
    throw new Error('Небезопасный путь в архиве');
  }
  const directory = raw.endsWith('/');
  const parts = raw.replace(/\/$/, '').split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.includes(':'))) {
    throw new Error('Недопустимый путь в архиве: ' + raw);
  }
  if (!ALLOWED_ROOTS.has(parts[0].toLowerCase()) || (parts.length < 2 && !directory)) {
    throw new Error('ZIP должен содержать папки mods/, config/ и другие игровые каталоги, без посторонних файлов: ' + raw);
  }
  return { relativePath: parts.join('/'), directory };
}

async function extractModpack(zipPath, destination, onProgress) {
  await mkdir(destination, { recursive: true });
  return new Promise((resolvePromise, rejectPromise) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true, decodeStrings: true },
      (openError, zip) => {
        if (openError || !zip) return rejectPromise(openError || new Error('Не удалось открыть ZIP'));
        let count = 0, total = 0;
        const paths = [], seen = new Set();
        let finished = false;
        function fail(error) {
          if (finished) return;
          finished = true;
          zip.close();
          rejectPromise(error);
        }
        zip.on('error', fail);
        zip.on('entry', (entry) => {
          (async () => {
            const validated = validateZipPath(entry.fileName);
            const key = validated.relativePath.toLowerCase();
            if (seen.has(key)) throw new Error('Повторяющийся путь в ZIP: ' + entry.fileName);
            seen.add(key);
            // Never materialize symlinks from untrusted ZIP metadata.
            const unixType = (entry.externalFileAttributes >>> 16) & 0o170000;
            if (unixType === 0o120000) throw new Error('Символические ссылки в сборке запрещены');
            if (validated.directory) {
              await mkdir(join(destination, ...validated.relativePath.split('/')), { recursive: true });
              return;
            }
            count++;
            total += entry.uncompressedSize;
            if (count > MAX_FILES || total > MAX_PACK_BYTES ||
                entry.uncompressedSize > 4 * 1024 * 1024 * 1024) {
              throw new Error('Превышен лимит файлов или размера сборки');
            }
            const absolute = join(destination, ...validated.relativePath.split('/'));
            await mkdir(dirname(absolute), { recursive: true });
            await new Promise((resolveStream, rejectStream) => {
              zip.openReadStream(entry, (error, input) => {
                if (error || !input) return rejectStream(error || new Error('Нет данных в ZIP'));
                pipeline(input, createWriteStream(absolute, { flags: 'wx' }))
                  .then(resolveStream, rejectStream);
              });
            });
            paths.push(validated.relativePath);
            if (count % 50 === 0) onProgress('Распаковано файлов: ' + count, null);
          })().then(() => zip.readEntry(), fail);
        });
        zip.on('end', () => {
          if (!finished) {
            finished = true;
            resolvePromise(paths);
          }
        });
        zip.readEntry();
      });
  });
}

async function ensureSafeDestination(root, relativePath) {
  const target = resolve(root, ...relativePath.split('/'));
  const rel = relative(root, target);
  if (!rel || rel.startsWith('..') || rel.includes('..' + sep)) throw new Error('Путь вне папки сборки');
  const parts = rel.split(sep);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    const entry = await lstat(current).catch((e) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    });
    if (entry?.isSymbolicLink()) throw new Error('В папке сборки обнаружена символическая ссылка');
  }
  return target;
}

function isProtectedFile(path) {
  const lower = path.toLowerCase();
  return lower === 'options.txt' || lower.startsWith('config/') ||
    lower.startsWith('defaultconfigs/');
}

function forceConfigPaths(manifest) {
  const supplied = manifest.forceConfigFiles ?? [];
  if (!Array.isArray(supplied) || supplied.length > 200) {
    throw new Error('Некорректный список обязательных обновлений config');
  }
  const chosen = new Set();
  for (const path of supplied) {
    if (typeof path !== 'string' || !/^(config|defaultconfigs)\//.test(path)) {
      throw new Error('Принудительно обновлять можно только config/ и defaultconfigs/');
    }
    const check = validateZipPath(path);
    if (check.directory || check.relativePath !== path || chosen.has(path.toLowerCase())) {
      throw new Error('Некорректный или повторяющийся файл принудительного обновления');
    }
    chosen.add(path.toLowerCase());
  }
  return chosen;
}

// Protect user options and config files by default. The pack author can
// explicitly force selected config files for a compatibility-breaking update.
// Forced config updates replace the selected files directly.
async function applyStagedModpack(staging, instanceRoot, paths, previousPaths, manifest, onProgress) {
  const wanted = new Set(paths.map((path) => path.toLowerCase()));
  const forced = forceConfigPaths(manifest);
  for (const key of forced) {
    if (!wanted.has(key)) throw new Error('Обязательный конфиг отсутствует в ZIP: ' + key);
  }
  let kept = 0, replaced = 0, created = 0;
  await mkdir(instanceRoot, { recursive: true });

  for (const path of paths) {
    const validated = validateZipPath(path);
    if (validated.directory) continue;
    const source = join(staging, ...path.split('/'));
    const target = await ensureSafeDestination(instanceRoot, path);
    const prior = await lstat(target).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (prior && (!prior.isFile() || prior.isSymbolicLink())) {
      throw new Error('На месте файла сборки находится не обычный файл: ' + path);
    }
    if (prior && isProtectedFile(path) && !forced.has(path.toLowerCase())) {
      kept++;
      continue;
    }
    if (prior && forced.has(path.toLowerCase())) {
      // Skip unchanged mandatory configs; changed ones overwrite user edits.
      if (await fileSha256(target) === await fileSha256(source)) {
        kept++;
        continue;
      }
    }
    await mkdir(dirname(target), { recursive: true });
    const temp = target + '.' + randomUUID() + '.part';
    try {
      await copyFile(source, temp);
      await rename(temp, target);
    } finally {
      await rm(temp, { force: true }).catch(() => {});
    }
    if (prior) replaced++;
    else created++;
  }

  // Remove older owned files, but never remove player options/config, even if
  // this release no longer ships them.
  for (const oldPath of previousPaths) {
    let validated;
    try { validated = validateZipPath(oldPath); }
    catch { continue; }
    if (validated.directory || isProtectedFile(oldPath) || wanted.has(oldPath.toLowerCase())) continue;
    const target = await ensureSafeDestination(instanceRoot, oldPath);
    await rm(target, { force: true });
  }

  // Purge any extraneous/injected files in mods/ (except CustomSkinLoader)
  const modsRoot = join(instanceRoot, 'mods');
  const modEntries = await readdir(modsRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of modEntries) {
    const relKey = ('mods/' + entry.name).toLowerCase();
    if (!wanted.has(relKey) && entry.name !== 'CustomSkinLoader-Events.jar') {
      await rm(join(modsRoot, entry.name), { recursive: true, force: true }).catch(() => {});
    }
  }
  const stats = { created, replaced, kept };
  if (kept) onProgress('Сохранены пользовательские настройки: ' + kept + ' файлов');
  return stats;
}

async function getInstalledPack(instanceRoot, manifest = config) {
  try {
    const data = JSON.parse(await readFile(join(instanceRoot, '.events', 'pack.json'), 'utf8'));
    return data.sha256 === manifest.sha256 && data.version === manifest.version;
  } catch {
    return false;
  }
}

async function installModpack(root, instanceRoot, onProgress, manifest = config) {
  if (!configuredModpack(manifest)) throw new Error('Сначала укажи публичную ссылку ZIP и SHA-256');
  const archive = await downloadArchive(root, onProgress, undefined, manifest);
  const staging = join(root, 'downloads', '.extract-' + randomUUID());
  try {
    onProgress('Проверяем содержимое ZIP и распаковываем…', null);
    const paths = await extractModpack(archive, staging, onProgress);
    if (paths.length === 0 || !paths.some((p) => p.startsWith('mods/'))) {
      throw new Error('В архиве нет папки mods/ с модами');
    }
    let previousPaths = [];
    try {
      const previous = JSON.parse(await readFile(join(instanceRoot, '.events', 'pack.json'), 'utf8'));
      if (Array.isArray(previous.files)) {
        previousPaths = previous.files.filter((path) => {
          try {
            return !validateZipPath(path).directory;
          } catch { return false; }
        });
      }
    } catch { /* first installation */ }
    const stats = await applyStagedModpack(staging, instanceRoot, paths, previousPaths, manifest, onProgress);
    const modFiles = [];
    for (const p of paths) {
      if (p.toLowerCase().startsWith('mods/')) {
        const full = join(instanceRoot, ...p.split('/'));
        try {
          const meta = await hashFile(full);
          modFiles.push({ path: p, name: basename(full), size: meta.size, sha256: meta.sha256 });
        } catch {}
      }
    }
    const metaDir = join(instanceRoot, '.events');
    await mkdir(metaDir, { recursive: true });
    await writeFile(join(metaDir, 'pack.json'), JSON.stringify({
      version: manifest.version, sha256: manifest.sha256,
      files: paths, modFiles, stats, installedAt: new Date().toISOString(),
    }, null, 2));
    onProgress('Модпак Project War установлен: ' + paths.length +
      ' файлов; сохранены настройки: ' + stats.kept);
    return { version: manifest.version, files: paths.length, ...stats };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  configuredModpack, trustedHost, googleDriveFileId,
  resolveSource, validateZipPath, downloadArchive,
  getInstalledPack, installModpack, applyStagedModpack, isProtectedFile, forceConfigPaths,
};
