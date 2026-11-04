'use strict';

// Hint the Windows graphics scheduler which GPU class to prefer for this
// launcher's Java runtime. This is an OS preference, not a hardware guarantee.
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const { mkdir, readFile, rename, rm, writeFile } = require('node:fs/promises');
const { dirname, win32 } = require('node:path');

const KEY = 'HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences';
const run = promisify(execFile);
const CODES = Object.freeze({
  automatic: null,
  integrated: '1',
  discrete: '2',
});

function validGpuPreference(value) {
  return typeof value === 'string' && Object.hasOwn(CODES, value);
}

function javaExecutable(path) {
  return typeof path === 'string' && win32.isAbsolute(path) &&
    ['javaw.exe', 'java.exe'].includes(win32.basename(path).toLowerCase()) &&
    !/[\r\n\u0000]/.test(path);
}

function withGpuPreference(current, selection) {
  if (!validGpuPreference(selection)) throw new Error('Недопустимый режим видеокарты');
  const parts = (current || '').split(';').map((part) => part.trim())
    .filter((part) => part && !/^GpuPreference\s*=/i.test(part));
  if (selection !== 'automatic') parts.push('GpuPreference=' + CODES[selection]);
  return parts.length ? parts.join(';') + ';' : null;
}

async function executeReg(args, runner) {
  return runner('reg.exe', args, {
    windowsHide: true, timeout: 10_000, maxBuffer: 32 * 1024, shell: false,
  });
}

async function getWindowsPreference(executable, runner = run) {
  try {
    const { stdout } = await executeReg(['query', KEY, '/v', executable], runner);
    const match = stdout.split(/\r?\n/).map((line) => /\bREG_SZ\s+(.*)$/i.exec(line))
      .find(Boolean);
    return match ? match[1].trim() : null;
  } catch (error) {
    // Windows reports a missing value or key with exit code 1.
    if (error.code === 1) return null;
    throw error;
  }
}

async function setWindowsPreference(executable, value, runner = run) {
  if (value === null) {
    try {
      await executeReg(['delete', KEY, '/v', executable, '/f'], runner);
    } catch (error) {
      if (error.code !== 1) throw error;
    }
  } else {
    await executeReg(['add', KEY, '/v', executable, '/t', 'REG_SZ', '/d', value, '/f'], runner);
  }
}

async function readManagedState(stateFile) {
  try {
    const parsed = JSON.parse(await readFile(stateFile, 'utf8'));
    if (parsed && javaExecutable(parsed.executable) &&
      (typeof parsed.original === 'string' || parsed.original === null) &&
      typeof parsed.applied === 'string') return parsed;
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  return null;
}

async function applyGpuPreference(executable, selection, stateFile, runner = run, platform = process.platform) {
  if (!validGpuPreference(selection)) throw new Error('Недопустимый режим видеокарты');
  if (platform !== 'win32') {
    if (selection !== 'automatic') throw new Error('Выбор видеокарты поддерживается только в Windows');
    return;
  }
  if (!javaExecutable(executable)) throw new Error('Неверный путь к Java');
  const previous = await readManagedState(stateFile);
  const managedForExecutable = previous && previous.executable.toLowerCase() === executable.toLowerCase();
  if (selection === 'automatic' && !managedForExecutable) return;
  const current = await getWindowsPreference(executable, runner);

  if (selection === 'automatic') {
    if (managedForExecutable) {
      // Do not undo a setting changed manually in Windows after our last run.
      if (current === previous.applied) {
        await setWindowsPreference(executable, previous.original, runner);
      }
      await rm(stateFile, { force: true });
    }
    return;
  }

  const desired = withGpuPreference(current, selection);
  if (desired === current) return;
  const original = managedForExecutable && current === previous.applied
    ? previous.original : current;
  await setWindowsPreference(executable, desired, runner);
  await mkdir(dirname(stateFile), { recursive: true });
  const temp = stateFile + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temp, JSON.stringify({ executable, original, applied: desired }), { flag: 'wx' });
    await rename(temp, stateFile);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

module.exports = {
  validGpuPreference, withGpuPreference, javaExecutable,
  getWindowsPreference, applyGpuPreference,
};
