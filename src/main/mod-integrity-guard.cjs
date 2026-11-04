'use strict';

const { createHash } = require('node:crypto');
const { createReadStream, watch } = require('node:fs');
const { lstat, readdir } = require('node:fs/promises');
const { join } = require('node:path');

const WATCH_VALIDATION_DEBOUNCE_MS = 100;

function hashFile(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    let size = 0;
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += bytes.length;
      hash.update(bytes);
    });
    stream.on('end', () => resolve({ sha256: hash.digest('hex'), size }));
  });
}

/**
 * Creates an integrity guard that watches and verifies the mods folder.
 * Prevents unauthorized mods from being launched or injected at runtime.
 *
 * @param {object} options
 * @param {string} options.modsRoot - absolute path to instanceRoot/mods
 * @param {Map<string, { size: number, sha256: string, name?: string }> | Record<string, { size: number, sha256: string, name?: string }>} options.expectedMods - map from lowercase filename to expected metadata
 * @param {Iterable<string>} [options.allowedGeneratedDirectories] - directories created dynamically by game runtime (e.g. .connector)
 */
function createModIntegrityGuard(options) {
  const { modsRoot } = options;
  const expected = options.expectedMods instanceof Map
    ? options.expectedMods
    : new Map(Object.entries(options.expectedMods || {}));

  const allowedDirs = new Set(
    Array.from(options.allowedGeneratedDirectories || []).map((d) => d.toLowerCase())
  );

  let watcher = null;
  let validationTimer = null;
  let validationQueue = Promise.resolve();
  let closed = false;
  let runtimeStarted = false;
  let violation = null;
  const listeners = new Set();

  function fail(message) {
    if (violation) return;
    violation = new Error(message);
    for (const listener of listeners) {
      try {
        listener(violation);
      } catch (err) {
        console.error('[ModIntegrityGuard] Listener error:', err);
      }
    }
  }

  async function validateContents() {
    if (closed || violation) return;
    let entries;
    try {
      entries = await readdir(modsRoot, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') {
        fail('Папка модов отсутствует: mods');
        return;
      }
      fail('Не удалось прочитать папку mods: ' + (err.message || err));
      return;
    }

    const actual = new Set();
    for (const entry of entries) {
      const normalized = entry.name.toLowerCase();

      if (entry.isSymbolicLink()) {
        fail('В папке mods обнаружена символическая ссылка: ' + entry.name);
        return;
      }

      if (entry.isDirectory()) {
        if (runtimeStarted && allowedDirs.has(normalized)) {
          continue;
        }
        fail('В папке mods обнаружена неизвестная папка: ' + entry.name);
        return;
      }

      if (!entry.isFile()) {
        fail('Неизвестный тип объекта в папке mods: ' + entry.name);
        return;
      }

      actual.add(normalized);
      const expectedFile = expected.get(normalized);
      if (!expectedFile) {
        fail('Обнаружен посторонний мод: ' + entry.name);
        return;
      }

      const fullPath = join(modsRoot, entry.name);
      try {
        const metadata = await hashFile(fullPath);
        if (metadata.size !== expectedFile.size) {
          fail('Размер мода не совпадает со сборкой: ' + entry.name);
          return;
        }
        if (metadata.sha256.toLowerCase() !== expectedFile.sha256.toLowerCase()) {
          fail('Контрольная сумма (SHA-256) мода изменена: ' + entry.name);
          return;
        }
      } catch (err) {
        fail('Не удалось проверить мод: ' + entry.name);
        return;
      }
    }

    if (!violation) {
      for (const [name, expectedFile] of expected.entries()) {
        if (!actual.has(name)) {
          fail('Отсутствует обязательный мод сборки: ' + (expectedFile.name || name));
          return;
        }
      }
    }
  }

  function queueValidation() {
    validationQueue = validationQueue.then(async () => {
      try {
        await validateContents();
      } catch (err) {
        fail('Ошибка проверки целостности модов: ' + (err.message || err));
      }
    });
    return validationQueue;
  }

  function scheduleValidation() {
    if (closed || violation) return;
    if (validationTimer) clearTimeout(validationTimer);
    validationTimer = setTimeout(() => {
      validationTimer = null;
      void queueValidation();
    }, WATCH_VALIDATION_DEBOUNCE_MS);
  }

  try {
    watcher = watch(modsRoot, scheduleValidation);
    watcher.on('error', (err) => {
      if (!closed) fail('Ошибка файлового вотчера mods: ' + (err.message || err));
    });
  } catch (err) {
    // If folder does not exist yet, assertClean() will catch it
  }

  return {
    async assertClean() {
      if (validationTimer) {
        clearTimeout(validationTimer);
        validationTimer = null;
      }
      await queueValidation();
      if (violation) throw violation;
    },
    markRuntimeStarted() {
      runtimeStarted = true;
    },
    close() {
      closed = true;
      if (validationTimer) clearTimeout(validationTimer);
      validationTimer = null;
      if (watcher) {
        try {
          watcher.close();
        } catch {}
        watcher = null;
      }
      listeners.clear();
    },
    onViolation(listener) {
      listeners.add(listener);
      if (violation) {
        try {
          listener(violation);
        } catch (err) {
          console.error('[ModIntegrityGuard] Listener error:', err);
        }
      }
    },
    getViolation() {
      return violation;
    },
  };
}

module.exports = {
  createModIntegrityGuard,
  hashFile,
  WATCH_VALIDATION_DEBOUNCE_MS,
};
