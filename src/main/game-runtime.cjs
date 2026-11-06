'use strict';

const { app } = require('electron');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { createReadStream, createWriteStream } = require('node:fs');
const { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } = require('node:fs/promises');
const { basename, dirname, join } = require('node:path');
const { createModIntegrityGuard, hashFile } = require('./mod-integrity-guard.cjs');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const extractZipPackage = require('@electron-internal/extract-zip');
const extractZip = extractZipPackage.default || extractZipPackage;
const { getVersionList, installTask, installDependenciesTask } = require('@xmcl/installer');
const { Version, launch } = require('@xmcl/core');
const { downloadNeoForgeInstaller } = require('./neoforge-installer.cjs');
const { configuredModpack, getInstalledPack, installModpack } = require('./modpack-installer.cjs');
const { memoryLimits, normalizeSettings, validateSettings } = require('./launcher-settings.cjs');
const { applyGpuPreference } = require('./gpu-preference.cjs');
const { SkinLibrary } = require('./skin-library.cjs');
const { createLauncherSession } = require('./launcher-session.cjs');
const { ensureSkinLoader } = require('./skin-loader-installer.cjs');
const { fetchReleasedModpack } = require('./release-manifest.cjs');
const bundledModpack = require('../../project-war.modpack.json');
const game = require('../../game-runtime.json');
const { formatInstallError } = require('./install-error.cjs');
const { withMinecraftDownloads } = require('./minecraft-downloads.cjs');
const { DownloadProgressMeter } = require('./download-progress.cjs');
const { fetchWithIdleTimeout } = require('./storage-fetch.cjs');

const ADOPTIUM_API = 'https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=x64&image_type=jre&os=windows&vendor=eclipse';
const AZUL_API = 'https://api.azul.com/metadata/v1/zulu/packages/?java_version=21&os=windows&arch=x64&archive_type=zip&java_package_type=jre&javafx_bundled=false&release_status=ga&availability_types=CA&latest=true&include_fields=sha256_hash&page_size=1';
const MAX_JAVA_ARCHIVE = 250 * 1024 * 1024;
const ALLOWED_JAVA_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'cdn.azul.com']);
const MAX_REDIRECTS = 5;

function safeNickname(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_]{3,16}$/.test(name)) {
    throw new Error('Ник: от 3 до 16 латинских букв, цифр или _');
  }
  return name;
}

function offlineUuid(nickname) {
  const bytes = createHash('md5').update('OfflinePlayer:' + safeNickname(nickname)).digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x30;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytes.toString('hex');
}

function javaAsset(assets) {
  const pkg = assets?.[0]?.binary?.package;
  if (!pkg || !Number.isSafeInteger(pkg.size) || pkg.size <= 0 || pkg.size > MAX_JAVA_ARCHIVE ||
      !/^[a-f0-9]{64}$/.test(pkg.checksum) || !/^OpenJDK21U-jre_x64_windows_hotspot_.*\.zip$/i.test(pkg.name)) {
    throw new Error('Некорректные метаданные Java 21');
  }
  const url = new URL(pkg.link);
  if (url.protocol !== 'https:' || !ALLOWED_JAVA_HOSTS.has(url.hostname) || url.username || url.password) {
    throw new Error('Недоверенный источник Java');
  }
  return { url: url.toString(), checksum: pkg.checksum, size: pkg.size };
}

function azulAsset(assets) {
  const pkg = assets?.[0];
  if (pkg?.java_version?.[0] !== 21 ||
      !/^zulu21\.[\w.-]+-ca-jre21\.[\w.-]+-win_x64\.zip$/.test(pkg?.name || '') ||
      !/^[a-f0-9]{64}$/.test(pkg?.sha256_hash || '')) {
    throw new Error('Некорректные метаданные Azul Java 21');
  }
  const url = new URL(pkg.download_url);
  if (url.protocol !== 'https:' || url.hostname !== 'cdn.azul.com' || url.username || url.password ||
      url.pathname !== '/zulu/bin/' + pkg.name) throw new Error('Недоверенный источник Azul Java');
  return { url: url.toString(), checksum: pkg.sha256_hash, size: MAX_JAVA_ARCHIVE };
}

async function downloadJavaArchive(root, progress, download = downloadVerifiedArchive) {
  const sources = [
    { name: 'Eclipse Temurin', api: ADOPTIUM_API, parse: javaAsset, file: 'temurin21-jre.zip' },
    { name: 'Azul Zulu', api: AZUL_API, parse: azulAsset, file: 'zulu21-jre.zip' },
  ];
  const failures = [];
  for (const source of sources) {
    try {
      progress(`Получаем Java 21 (${source.name})…`, null);
      const res = await fetch(source.api, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const pkg = source.parse(await res.json());
      return await download(pkg.url, join(root, 'downloads', source.file), pkg.checksum, pkg.size,
        progress, source.parse === azulAsset ? undefined : pkg.size);
    } catch (error) {
      failures.push(new Error(source.name + ': ' + (error.message || error), { cause: error }));
      if (source !== sources.at(-1)) progress('Источник Java недоступен. Пробуем резервный источник…', null);
    }
  }
  throw new AggregateError(failures, 'Не удалось скачать Java 21. ' + failures.map(e => e.message).join('; '));
}

async function downloadFollowingTrustedRedirects(url, initialHostname, max = MAX_REDIRECTS) {
  let current = new URL(url);
  for (let i = 0; i <= max; i++) {
    if (current.protocol !== 'https:' || current.username || current.password ||
        (initialHostname === 'java' && !ALLOWED_JAVA_HOSTS.has(current.hostname))) {
      throw new Error('Недоверенный адрес загрузки');
    }
    const res = await fetchWithIdleTimeout(fetch, current, { redirect: 'manual' }, 60_000, 30_000);
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      await res.body?.cancel();
      if (!location) throw new Error('Пустое перенаправление загрузки');
      current = new URL(location, current);
      continue;
    }
    if (!res.ok || !res.body) throw new Error('Ошибка загрузки HTTP ' + res.status);
    return res;
  }
  throw new Error('Слишком много перенаправлений');
}

async function downloadVerifiedArchive(url, output, expectedHash, maxBytes, onProgress, expectedTotalBytes) {
  const existing = await stat(output).catch(() => null);
  if (existing?.isFile() && existing.size <= maxBytes) {
    const h = createHash('sha256');
    for await (const chunk of createReadStream(output)) h.update(chunk);
    if (h.digest('hex') === expectedHash) return output;
  }
  const temp = output + '.' + randomUUID() + '.part';
  await mkdir(dirname(output), { recursive: true });
  try {
    const response = await downloadFollowingTrustedRedirects(url, 'java');
    const contentLength = Number(response.headers.get('content-length')) || expectedTotalBytes || 0;
    const meter = new DownloadProgressMeter({
      label: 'Скачиваем Java 21',
      total: contentLength,
      onProgress,
    });
    meter.emit();
    let size = 0;
    const h = createHash('sha256');
    const tracker = new Transform({
      transform(chunk, enc, cb) {
        size += chunk.length;
        if (size > maxBytes) return cb(new Error('Слишком большой архив Java'));
        h.update(chunk);
        meter.update(size, contentLength);
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), tracker, createWriteStream(temp, { flags: 'wx' }));
    if (h.digest('hex') !== expectedHash) throw new Error('Неверная контрольная сумма Java');
    await rm(output, { force: true });
    await rename(temp, output);
    return output;
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

async function findJava(root, file = 'java.exe') {
  const direct = join(root, 'bin', file);
  if ((await stat(direct).catch(() => null))?.isFile()) return direct;
  const items = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const item of items) {
    if (!item.isDirectory() || item.isSymbolicLink()) continue;
    const path = join(root, item.name, 'bin', file);
    if ((await stat(path).catch(() => null))?.isFile()) return path;
  }
  return null;
}

function runCommand(program, args, cwd, onOutput, timeoutMs = 10 * 60_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const report = (chunk) => {
      output = (output + chunk.toString('utf8')).slice(-8_000);
      onOutput?.(chunk.toString('utf8').trim().slice(0, 180));
    };
    child.stdout?.on('data', report);
    child.stderr?.on('data', report);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error('Время установки истекло'));
      if (code === 0) resolve();
      else reject(new Error('Установщик завершился с кодом ' + code + ': ' + output.slice(-500)));
    });
  });
}

async function ensureJava(root, progress) {
  const javaRoot = join(root, 'java', '21');
  const cached = await findJava(javaRoot);
  if (cached) return cached;
  const archive = await downloadJavaArchive(root, progress);
  const stage = join(root, 'java', '.staging-' + randomUUID());
  await mkdir(stage, { recursive: true });
  try {
    progress('Распаковываем Java 21…', null);
    await extractZip(archive, { dir: stage });
    const java = await findJava(stage);
    if (!java) throw new Error('Архив Java не содержит java.exe');
    await runCommand(java, ['-version'], stage, undefined, 10_000);
    await rm(javaRoot, { recursive: true, force: true });
    await rename(stage, javaRoot);
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
  }
  const installed = await findJava(javaRoot);
  if (!installed) throw new Error('Java 21 не установилась');
  return installed;
}

function neoforgeVersionId(name) {
  return name === 'neoforge-' + game.loaderVersion || name === game.minecraftVersion + '-neoforge-' + game.loaderVersion;
}

async function findNeoForgeVersion(minecraftRoot) {
  const root = join(minecraftRoot, 'versions');
  const versions = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const item of versions) {
    if (!item.isDirectory() || !neoforgeVersionId(item.name)) continue;
    const json = await readFile(join(root, item.name, item.name + '.json'), 'utf8').catch(() => null);
    if (!json) continue;
    try {
      const parsed = JSON.parse(json);
      if (parsed.id === item.name && Array.isArray(parsed.libraries) &&
          typeof parsed.mainClass === 'string' && parsed.mainClass.length > 0) return item.name;
    } catch { /* retry install */ }
  }
  return null;
}

function marker(root) {
  return join(root, 'runtime-ready.json');
}

async function readReady(root) {
  const json = await readFile(marker(root), 'utf8').catch(() => null);
  if (!json) return null;
  try {
    const data = JSON.parse(json);
    if (data.minecraft === game.minecraftVersion && data.neoforge === game.loaderVersion &&
        data.java === game.javaMajor && await findJava(join(root, 'java', '21')) &&
        await findNeoForgeVersion(join(root, 'minecraft')) === data.versionId) return data;
  } catch { /* incomplete install */ }
  return null;
}

class EventGameRuntime {
  constructor(report) {
    this.report = report;
    const userData = typeof app?.getPath === 'function' ? app.getPath('userData') : process.cwd();
    this.root = join(userData, 'game-data');
    this.minecraftRoot = join(this.root, 'minecraft');
    this.instanceRoot = join(this.root, 'instances', 'project-war');
    this.busy = false;
    this.process = null;
    this.phase = 'idle';
    this.detail = 'Ещё не установлено';
    this.lastError = null;
    this.downloadProgress = null;
    this.manifest = configuredModpack(bundledModpack) ? bundledModpack : null;
    this.packConfigured = Boolean(this.manifest);
    this.packInstalled = false;
    this.packUpdateAvailable = false;
    this.settingsFile = join(userData, 'launcher-settings.json');
    this.gpuPreferenceStateFile = join(userData, 'managed-gpu-preference.json');
    this.settingsLimits = memoryLimits();
    this.settings = normalizeSettings(null, this.settingsLimits);
    this.skins = new SkinLibrary(userData);
  }

  getSettings() {
    return { ...this.settings, ...this.settingsLimits };
  }

  async saveSettings(input) {
    if (this.busy || this.process) throw new Error('Настройки нельзя менять во время установки или игры');
    const next = validateSettings(input, this.settingsLimits);
    await mkdir(dirname(this.settingsFile), { recursive: true });
    const temp = this.settingsFile + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temp, JSON.stringify(next, null, 2), { flag: 'wx' });
      await rename(temp, this.settingsFile);
    } finally {
      await rm(temp, { force: true }).catch(() => undefined);
    }
    this.settings = next;
    return this.getSettings();
  }

  snapshot() {
    return {
      phase: this.phase, detail: this.detail, error: this.lastError,
      downloadProgress: this.downloadProgress,
      packConfigured: this.packConfigured, packInstalled: this.packInstalled,
      packUpdateAvailable: this.packUpdateAvailable,
    };
  }

  update(phase, detail, error = null, progress = null) {
    this.downloadProgress = progress;
    this.phase = phase;
    this.detail = detail;
    this.lastError = error;
    this.report(this.snapshot());
    return this.snapshot();
  }

  async initialize() {
    try {
      const stored = JSON.parse(await readFile(this.settingsFile, 'utf8'));
      this.settings = normalizeSettings(stored, this.settingsLimits);
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    this.packInstalled = Boolean(this.manifest) && await getInstalledPack(this.instanceRoot, this.manifest);
    if (await readReady(this.root)) this.update('ready', 'Minecraft и NeoForge подготовлены');
    return this.snapshot();
  }

  async trackDownload(task, label = 'Скачиваем Minecraft') {
    this.downloadProgress = null;
    const initialTotal = Math.max(0, Number(task.total) || 0);
    const meter = new DownloadProgressMeter({
      label,
      total: initialTotal,
      onProgress: (detail, progress) => {
        this.detail = detail;
        this.downloadProgress = progress;
        this.report(this.snapshot());
      },
    });
    meter.emit();
    return task.startAndWait({
      onUpdate: current => {
        if (current !== task) return;
        const total = Math.max(0, Number(task.total) || 0);
        const downloaded = Math.min(total || Number.MAX_SAFE_INTEGER, Math.max(0, Number(task.progress) || 0));
        meter.update(downloaded, total);
      },
    });
  }

  async install() {
    if (this.busy || this.process) throw new Error('Установка или игра уже запущена');
    this.busy = true;
    try {
      await mkdir(this.minecraftRoot, { recursive: true });
      await mkdir(this.instanceRoot, { recursive: true });
      const downloadProgress = (detail, progress = null) => this.update('installing', detail, null, progress);
      const java = await ensureJava(this.root, downloadProgress);

      this.update('installing', 'Скачиваем Minecraft ' + game.minecraftVersion + '…');
      const list = await withMinecraftDownloads(options => getVersionList({ fetch: options.fetch }), downloadProgress);
      const vanilla = list.versions.find((v) => v.id === game.minecraftVersion && v.type === 'release');
      if (!vanilla) throw new Error('Minecraft ' + game.minecraftVersion + ' не найден в манифесте');
      await withMinecraftDownloads(options => this.trackDownload(installTask(vanilla, this.minecraftRoot, options), 'Скачиваем Minecraft ' + game.minecraftVersion), downloadProgress);

      let versionId = await findNeoForgeVersion(this.minecraftRoot);
      if (!versionId) {
        this.update('installing', 'Проверяем загрузку установщика NeoForge…');
        const installer = await downloadNeoForgeInstaller(join(this.root, 'downloads'), undefined, downloadProgress);
        const profilesPath = join(this.minecraftRoot, 'launcher_profiles.json');
        try {
          await stat(profilesPath);
        } catch {
          await writeFile(profilesPath, JSON.stringify({ profiles: {}, settings: {}, version: 3 }));
        }
        this.update('installing', 'Устанавливаем NeoForge ' + game.loaderVersion + '…');
        await runCommand(java, ['-Djava.net.preferIPv4Stack=true', '-jar', installer, '--installClient', this.minecraftRoot],
          this.minecraftRoot, (line) => {
            if (line) this.update('installing', 'NeoForge: ' + line);
          });
        versionId = await findNeoForgeVersion(this.minecraftRoot);
        if (!versionId) throw new Error('NeoForge не создал корректный игровой профиль');
      }

      this.update('installing', 'Проверяем библиотеки и ресурсы NeoForge…');
      const resolved = await Version.parse(this.minecraftRoot, versionId);
      await withMinecraftDownloads(options => this.trackDownload(installDependenciesTask(resolved, options), 'Скачиваем библиотеки NeoForge'), downloadProgress);
      await writeFile(marker(this.root), JSON.stringify({
        schemaVersion: 1, minecraft: game.minecraftVersion, neoforge: game.loaderVersion,
        java: game.javaMajor, versionId, installedAt: new Date().toISOString(),
      }));
      return this.update('ready', 'Minecraft 1.21.1 и NeoForge установлены');
    } catch (error) {
      const failedStep = this.detail;
      const reason = formatInstallError(error);
      const logFile = join(this.root, 'install-error.log');
      await writeFile(logFile, `${new Date().toISOString()}\nЭтап: ${failedStep}\n${reason}\n`, { flag: 'a' })
        .catch((logError) => console.error('[install log]', logError));
      console.error('[install]', failedStep, error);
      return this.update('error', 'Не удалось завершить установку', `${failedStep}: ${reason}`);
    } finally {
      this.busy = false;
    }
  }

  async fetchPackStatus() {
    const published = await fetchReleasedModpack();
    const manifest = published ?? (configuredModpack(bundledModpack) ? bundledModpack : null);
    // If a previously managed pack exists, never launch without its published
    // version metadata: it could be outdated or withdrawn.
    if (!manifest) {
      const marker = await stat(join(this.instanceRoot, '.events', 'pack.json')).catch(() => null);
      if (marker) throw new Error('Манифест установленной сборки недоступен в GitHub Releases');
    }
    this.manifest = manifest;
    this.packConfigured = Boolean(manifest);
    this.packInstalled = manifest ? await getInstalledPack(this.instanceRoot, manifest) : false;
    this.packUpdateAvailable = Boolean(manifest) && !this.packInstalled
      && Boolean(await stat(join(this.instanceRoot, '.events', 'pack.json')).catch(() => null));
    return manifest;
  }

  async checkPackUpdates() {
    if (this.busy || this.process) return this.snapshot();
    if (!await readReady(this.root)) return this.snapshot();
    this.busy = true;
    this.update('checking-pack', 'Проверяем обновления Project War…');
    try {
      await this.fetchPackStatus();
      return this.update('ready',
        this.packUpdateAvailable ? 'Доступно обновление сборки' : 'Версия сборки проверена');
    } catch (error) {
      // Startup check failures are visible, but cannot silently bypass the
      // network requirement on Play.
      return this.update('ready', 'Не удалось проверить сборку', String(error?.message || error));
    } finally {
      this.busy = false;
    }
  }

  async installPack() {
    if (this.busy || this.process) throw new Error('Установка или игра уже запущена');
    if (!await readReady(this.root)) throw new Error('Сначала установи Minecraft и NeoForge');
    this.busy = true;
    try {
      this.update('checking-pack', 'Проверяем обновления Project War…');
      const manifest = await this.fetchPackStatus();
      if (!manifest) throw new Error('Модпак Project War ещё не опубликован');
      this.update('installing-pack', 'Подготавливаем архив Project War…');
      await installModpack(this.root, this.instanceRoot,
        (detail, progress) => this.update('installing-pack', detail, null, progress), manifest);
      this.packInstalled = true;
      this.packUpdateAvailable = false;
      return this.update('ready', 'Project War установлен и готов к запуску');
    } catch (error) {
      this.packInstalled = false;
      this.update('ready', 'Не удалось установить модпак Project War', String(error?.message || error));
      throw error;
    } finally {
      this.busy = false;
    }
  }

  async getExpectedMods() {
    const expected = new Map();
    const packJsonPath = join(this.instanceRoot, '.events', 'pack.json');
    let packData = null;
    try {
      packData = JSON.parse(await readFile(packJsonPath, 'utf8'));
    } catch {}

    if (packData) {
      if (Array.isArray(packData.modFiles) && packData.modFiles.length > 0) {
        for (const file of packData.modFiles) {
          const lower = (file.name || basename(file.path)).toLowerCase();
          expected.set(lower, {
            name: file.name || basename(file.path),
            size: file.size,
            sha256: file.sha256,
          });
        }
      } else if (Array.isArray(packData.files)) {
        // Fallback for earlier installations: populate modFiles and persist
        const modFiles = [];
        for (const relPath of packData.files) {
          if (relPath.toLowerCase().startsWith('mods/')) {
            const full = join(this.instanceRoot, ...relPath.split('/'));
            try {
              const meta = await hashFile(full);
              const name = basename(full);
              modFiles.push({ path: relPath, name, size: meta.size, sha256: meta.sha256 });
              expected.set(name.toLowerCase(), { name, size: meta.size, sha256: meta.sha256 });
            } catch {}
          }
        }
        if (modFiles.length > 0) {
          packData.modFiles = modFiles;
          await writeFile(packJsonPath, JSON.stringify(packData, null, 2)).catch(() => {});
        }
      }
    }

    // Include CustomSkinLoader if installed
    const skinLoaderPath = join(this.instanceRoot, 'mods', 'CustomSkinLoader-Events.jar');
    const skinMeta = await lstat(skinLoaderPath).catch(() => null);
    if (skinMeta?.isFile()) {
      try {
        const hashed = await hashFile(skinLoaderPath);
        expected.set('customskinloader-events.jar', {
          name: 'CustomSkinLoader-Events.jar',
          size: hashed.size,
          sha256: hashed.sha256,
        });
      } catch {}
    }

    return expected;
  }

  async launch(nickname) {
    if (this.busy || this.process) throw new Error('Игра или установка уже запущена');
    const name = safeNickname(nickname);
    const ready = await readReady(this.root);
    if (!ready) throw new Error('Сначала установи Minecraft и NeoForge');
    this.busy = true;
    try {
      this.update('checking-pack', 'Проверяем обновления Project War…');
      const manifest = await this.fetchPackStatus();
      if (manifest && !this.packInstalled) {
        this.update('installing-pack', 'Устанавливаем актуальную сборку Project War…');
        await installModpack(this.root, this.instanceRoot,
          (detail, progress) => this.update('installing-pack', detail, null, progress), manifest);
        this.packInstalled = true;
        this.packUpdateAvailable = false;
      }
      const java = await findJava(join(this.root, 'java', '21'), 'javaw.exe') ||
                   await findJava(join(this.root, 'java', '21'), 'java.exe');
      if (!java) throw new Error('Java 21 не найдена');
      await applyGpuPreference(java, this.settings.gpuPreference, this.gpuPreferenceStateFile);
      await mkdir(this.instanceRoot, { recursive: true });
      const activeSkin = await this.skins.selected();
      if (activeSkin) {
        this.update('launching', 'Подготавливаем локальный скин…');
        await ensureSkinLoader(this.instanceRoot,
          (detail) => this.update('launching', detail));
      }
      await this.skins.syncForLaunch(this.instanceRoot, name);

      this.update('launching', 'Проверяем целостность модов…');
      const expectedMods = await this.getExpectedMods();
      const guard = createModIntegrityGuard({
        modsRoot: join(this.instanceRoot, 'mods'),
        expectedMods,
        allowedGeneratedDirectories: ['.connector', '.cache'],
      });
      await guard.assertClean();

      // New ephemeral per-process proof, not bound to nickname or Windows device.
      const playerCredentials = createLauncherSession(app.getVersion());
      this.update('launching', 'Запускаем NeoForge с локальным ником…');
      const defaultJvmFlags = [
        '-XX:+UnlockExperimentalVMOptions',
        '-XX:+UseG1GC',
        '-XX:G1NewSizePercent=20',
        '-XX:G1ReservePercent=20',
        '-XX:MaxGCPauseMillis=50',
        '-XX:G1HeapRegionSize=32M',
      ];
      const customJvmFlags = (this.settings.jvmArguments || '')
        .split(/\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const extraJVMArgs = [...defaultJvmFlags, ...customJvmFlags];
      const child = await launch({
        javaPath: java,
        version: ready.versionId,
        gamePath: this.instanceRoot,
        resourcePath: this.minecraftRoot,
        gameProfile: { name, id: offlineUuid(name) },
        accessToken: '0',
        userType: 'legacy',
        launcherName: 'Events Launcher',
        maxMemory: this.settings.memoryMb,
        minMemory: 512,
        extraExecOption: {
          env: { ...process.env, ...playerCredentials },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
        extraJVMArgs,
      });
      this.process = child;
      guard.markRuntimeStarted();

      let integrityViolation = null;
      guard.onViolation((error) => {
        integrityViolation = error;
        console.error('[ModIntegrityGuard] Обнаружено вмешательство в папку модов:', error.message);
        if (child.exitCode === null && !child.killed) {
          try { child.kill('SIGKILL'); } catch {}
        }
        this.process = null;
        this.update('error', 'Игра закрыта: ' + error.message, error.message);
      });

      const recentOutput = [];
      const recordLine = (chunk) => {
        const text = String(chunk);
        for (const line of text.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (trimmed) {
            recentOutput.push(trimmed);
            if (recentOutput.length > 50) recentOutput.shift();
          }
        }
      };
      if (child.stdout) {
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', recordLine);
        child.stdout.resume();
      }
      if (child.stderr) {
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', recordLine);
        child.stderr.resume();
      }
      this.update('running', 'Minecraft запущен');
      child.once('exit', (code) => {
        guard.close();
        this.process = null;
        if (integrityViolation) return;
        const lastErr = code !== 0 && recentOutput.length
          ? recentOutput.slice(-3).join(' | ')
          : null;
        this.update(code === 0 ? 'ready' : 'error',
          code === 0 ? 'Minecraft закрыт' : 'Minecraft завершился с кодом ' + code,
          lastErr || (code === 0 ? null : 'game_exit_code:' + code));
      });
      child.once('error', (e) => {
        guard.close();
        this.process = null;
        this.update('error', 'Ошибка процесса Minecraft', e.message);
      });
      return this.snapshot();
    } catch (error) {
      if (typeof guard !== 'undefined' && guard) guard.close();
      this.update('ready', 'Не удалось запустить Minecraft', String(error?.message || error));
      throw error;
    } finally {
      this.busy = false;
    }
  }
}

module.exports = { EventGameRuntime, safeNickname, offlineUuid, javaAsset, azulAsset, downloadJavaArchive, neoforgeVersionId };
