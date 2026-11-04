'use strict';

// Versioned modpack metadata published as a GitHub Releases asset.
// Pack ZIP files themselves remain on Yandex Disk / Google Drive.
const { Readable } = require('node:stream');

const RELEASE_API = 'https://api.github.com/repos/Fastyk829/events-launcher/releases/tags/project-war-modpack';
const RELEASE_ASSET = 'https://github.com/Fastyk829/events-launcher/releases/download/project-war-modpack/project-war.modpack.json';
const ASSET_NAME = 'project-war.modpack.json';
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_REDIRECTS = 5;

function trustedGithubAsset(host) {
  return host === 'github.com' || host === 'release-assets.githubusercontent.com' ||
    host === 'objects.githubusercontent.com' || host === 'github-releases.githubusercontent.com';
}

function validateManifest(data) {
  if (!data || typeof data !== 'object' || data.schemaVersion !== 1 ||
      data.eventId !== 'project-war' ||
      typeof data.version !== 'string' || !/^[0-9a-zA-Z][0-9a-zA-Z._+-]{0,63}$/.test(data.version) ||
      typeof data.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(data.sha256) ||
      !Array.isArray(data.sources) || data.sources.length < 1 || data.sources.length > 4) {
    throw new Error('Некорректный манифест сборки в GitHub Releases');
  }
  const sources = data.sources.map((source) => {
    if (!source || typeof source.publicUrl !== 'string' || source.publicUrl.length > 2048) {
      throw new Error('Некорректная ссылка на архив сборки');
    }
    let url;
    try { url = new URL(source.publicUrl); } catch { throw new Error('Некорректный URL архива'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) {
      throw new Error('Источник сборки должен использовать HTTPS');
    }
    if (source.provider === 'yandex-disk') {
      if (!['disk.yandex.ru', 'disk.yandex.com', 'yadi.sk'].includes(url.hostname)) {
        throw new Error('Неизвестный адрес Яндекс Диска');
      }
    } else if (source.provider === 'google-drive') {
      const id = /^\/file\/d\/([A-Za-z0-9_-]{10,128})(?:\/|$)/.exec(url.pathname)?.[1] ||
        url.searchParams.get('id');
      if (url.hostname !== 'drive.google.com' || !id || !/^[A-Za-z0-9_-]{10,128}$/.test(id)) {
        throw new Error('Неправильная публичная ссылка Google Drive');
      }
    } else {
      throw new Error('Источник ZIP-сборки не поддерживается');
    }
    return { provider: source.provider, publicUrl: url.toString() };
  });
  // Files listed here are intentionally replaced even when players edited
  // them locally. The installer creates a backup before replacing each file.
  const forceConfigFiles = data.forceConfigFiles ?? [];
  if (!Array.isArray(forceConfigFiles) || forceConfigFiles.length > 200) {
    throw new Error('Неверное поле forceConfigFiles');
  }
  const seen = new Set();
  const forced = forceConfigFiles.map((path) => {
    if (typeof path !== 'string' ||
        !/^(config|defaultconfigs)\/[a-zA-Z0-9._+\-/]{1,230}$/.test(path) ||
        path.split('/').some((part) => part === '.' || part === '..' || !part) ||
        path.endsWith('/')) throw new Error('Обязательное обновление может затрагивать только файлы config/');
    const key = path.toLowerCase();
    if (seen.has(key)) throw new Error('Повторяющийся путь в forceConfigFiles');
    seen.add(key);
    return path;
  });
  return {
    schemaVersion: 1, eventId: 'project-war',
    version: data.version, sha256: data.sha256, sources, forceConfigFiles: forced,
  };
}

async function readSmallJson(response) {
  if (!response.ok || !response.body) throw new Error('Не удалось получить манифест (HTTP ' + response.status + ')');
  const chunks = [];
  let total = 0;
  for await (const chunk of Readable.fromWeb(response.body)) {
    total += chunk.length;
    if (total > MAX_MANIFEST_BYTES) throw new Error('Слишком большой манифест сборки');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('GitHub вернул некорректный JSON'); }
}

async function fetchAsset(url, fetcher) {
  let current = new URL(url);
  for (let index = 0; index <= MAX_REDIRECTS; index++) {
    if (current.protocol !== 'https:' || !trustedGithubAsset(current.hostname) ||
        current.username || current.password || current.port) {
      throw new Error('GitHub перенаправил загрузку на недоверенный адрес');
    }
    const response = await fetcher(current.toString(), {
      redirect: 'manual', signal: AbortSignal.timeout(15_000),
      headers: { Accept: 'application/octet-stream', 'User-Agent': 'EventsLauncher/0.1' },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('Некорректное перенаправление GitHub');
      current = new URL(location, current);
      continue;
    }
    return readSmallJson(response);
  }
  throw new Error('Слишком много перенаправлений GitHub');
}

async function fetchReleasedModpack(fetcher = fetch) {
  const response = await fetcher(RELEASE_API, {
    redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'EventsLauncher/0.1' },
  });
  // A fresh/private repository has no public published modpack release yet.
  if (response.status === 404) return null;
  const release = await readSmallJson(response);
  if (release.draft || release.prerelease !== true || release.tag_name !== 'project-war-modpack') {
    throw new Error('Релиз модпака должен быть опубликован как pre-release');
  }
  const asset = release.assets?.find((x) => x.name === ASSET_NAME && x.state === 'uploaded');
  if (!asset || asset.browser_download_url !== RELEASE_ASSET) {
    throw new Error('В релизе сборки нет project-war.modpack.json');
  }
  return validateManifest(await fetchAsset(asset.browser_download_url, fetcher));
}

module.exports = { fetchReleasedModpack, validateManifest, trustedGithubAsset };
