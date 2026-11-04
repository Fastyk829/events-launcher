'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { mkdir, readFile, writeFile, rename, rm, lstat } = require('node:fs/promises');
const { basename, dirname, join } = require('node:path');

const MAX_SKINS = 16;
const MAX_PNG_BYTES = 1024 * 1024;
const MODELS = new Set(['default', 'slim']);
const ID_PATTERN = /^[a-f0-9-]{36}$/;
const NICK_PATTERN = /^[A-Za-z0-9_]{3,16}$/;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function validateSkinPng(bytes, decodedImport = false) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 45 || bytes.length > MAX_PNG_BYTES ||
      !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
      bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('Нужен PNG-файл скина Minecraft (64×64 или 64×32)');
  }
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  const supported = (width === 64 && (height === 64 || height === 32)) ||
    ([128, 256].includes(width) && height === width);
  if (!supported) {
    throw new Error(`Размер скина ${width}×${height}. Нужен PNG 64×64, 64×32, 128×128 или 256×256.`);
  }
  if ((!decodedImport && (bytes[24] !== 8 || ![2, 6].includes(bytes[25]) || bytes[28] !== 0)) ||
      bytes[26] !== 0 || bytes[27] !== 0) {
    throw new Error('Нужен PNG RGB/RGBA; попробуйте сохранить скин в формате PNG ещё раз.');
  }
  return { width, height };
}

function cleanIndex(value) {
  if (!value || typeof value !== 'object') return { activeId: null, skins: [] };
  const skins = Array.isArray(value.skins) ? value.skins.filter((s) =>
    s && ID_PATTERN.test(s.id) && typeof s.name === 'string' &&
    s.name.length <= 48 && MODELS.has(s.model)) : [];
  return {
    activeId: skins.some((s) => s.id === value.activeId) ? value.activeId : null,
    skins: skins.slice(0, MAX_SKINS),
  };
}

async function atomicJson(file, object) {
  await mkdir(dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temp, JSON.stringify(object, null, 2), { flag: 'wx' });
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return fallback;
    throw error;
  }
}

class SkinLibrary {
  constructor(userRoot) {
    this.root = join(userRoot, 'skins');
    this.index = join(this.root, 'index.json');
    this.syncState = join(this.root, 'last-synced.json');
  }

  async readIndex() {
    return cleanIndex(await readJson(this.index, null));
  }

  async list() {
    const index = await this.readIndex();
    const skins = [];
    for (const item of index.skins) {
      const path = join(this.root, item.id + '.png');
      try {
        const data = await readFile(path);
        validateSkinPng(data);
        skins.push({ ...item, preview: 'data:image/png;base64,' + data.toString('base64') });
      } catch { /* orphaned or damaged PNG */ }
    }
    const activeId = skins.some((s) => s.id === index.activeId) ? index.activeId : null;
    return { activeId, skins };
  }

  async importFile(path, decode) {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_PNG_BYTES || info.size < 45) {
      throw new Error('Слишком большой файл или неверный формат PNG (максимум 1 МБ)');
    }
    let data = await readFile(path);
    validateSkinPng(data, typeof decode === 'function');
    if (typeof decode === 'function') {
      const decoded = decode(data);
      if (!decoded) throw new Error('PNG скина повреждён или не открывается');
      if (Buffer.isBuffer(decoded)) data = decoded;
    }
    validateSkinPng(data);
    const index = await this.readIndex();
    if (index.skins.length >= MAX_SKINS) throw new Error('В библиотеке может быть до 16 скинов');
    const id = randomUUID();
    const label = basename(path).replace(/\.png$/i, '').trim().slice(0, 48) || 'Скин';
    await mkdir(this.root, { recursive: true });
    await writeFile(join(this.root, id + '.png'), data, { flag: 'wx' });
    try {
      index.skins.push({ id, name: label, model: 'default' });
      index.activeId = id;
      await atomicJson(this.index, index);
    } catch (error) {
      await rm(join(this.root, id + '.png'), { force: true });
      throw error;
    }
    return this.list();
  }

  async select(id) {
    const index = await this.readIndex();
    if (id !== null && !index.skins.some((s) => s.id === id)) throw new Error('Скин не найден');
    index.activeId = id;
    await atomicJson(this.index, index);
    return this.list();
  }

  async setModel(id, model) {
    const index = await this.readIndex();
    if (!MODELS.has(model)) throw new Error('Неизвестная модель скина');
    const skin = index.skins.find((s) => s.id === id);
    if (!skin) throw new Error('Скин не найден');
    skin.model = model;
    await atomicJson(this.index, index);
    return this.list();
  }

  async remove(id) {
    const index = await this.readIndex();
    if (!index.skins.some((s) => s.id === id)) throw new Error('Скин не найден');
    index.skins = index.skins.filter((s) => s.id !== id);
    if (index.activeId === id) index.activeId = null;
    await atomicJson(this.index, index);
    await rm(join(this.root, id + '.png'), { force: true });
    return this.list();
  }

  async selected() {
    const index = await this.readIndex();
    const active = index.skins.find((s) => s.id === index.activeId);
    if (!active) return null;
    const data = await readFile(join(this.root, active.id + '.png'));
    validateSkinPng(data);
    return { ...active, data };
  }

  async syncForLaunch(instanceRoot, nickname) {
    if (!NICK_PATTERN.test(nickname)) throw new Error('Сначала укажи правильный игровой ник');
    const active = await this.selected();
    const previous = await readJson(this.syncState, null);
    const skinsFolder = join(instanceRoot, 'CustomSkinLoader', 'LocalSkin', 'skins');
    if (previous && NICK_PATTERN.test(previous.nickname) &&
        /^[a-f0-9]{64}$/.test(previous.hash)) {
      const oldPath = join(skinsFolder, previous.nickname + '.png');
      const matching = active && previous.nickname === nickname &&
        previous.id === active.id;
      if (!matching) {
        try {
          const old = await readFile(oldPath);
          if (createHash('sha256').update(old).digest('hex') === previous.hash) {
            await rm(oldPath, { force: true });
          }
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
    }
    if (!active) {
      await rm(this.syncState, { force: true });
      return false;
    }
    const dest = join(skinsFolder, nickname + '.png');
    await mkdir(skinsFolder, { recursive: true });
    const temp = dest + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temp, active.data, { flag: 'wx' });
      await rename(temp, dest);
    } finally {
      await rm(temp, { force: true }).catch(() => {});
    }
    await atomicJson(this.syncState, {
      id: active.id, nickname, hash: createHash('sha256').update(active.data).digest('hex'),
    });
    await configureLocalSkin(instanceRoot, active.model);
    return true;
  }
}

async function configureLocalSkin(instanceRoot, model) {
  if (!MODELS.has(model)) throw new Error('Неверная модель скина');
  const file = join(instanceRoot, 'CustomSkinLoader', 'CustomSkinLoader.json');
  const existing = await readJson(file, null);
  // Keep all other sources intact. LocalSkin must win over online textures for
  // our offline profile, and the model is set by the selected skin.
  const loadlist = Array.isArray(existing?.loadlist) ? existing.loadlist.filter(
    (entry) => entry && entry.name !== 'LocalSkin') : [];
  loadlist.unshift({
    name: 'LocalSkin', type: 'Legacy', checkPNG: false,
    skin: 'LocalSkin/skins/{USERNAME}.png', model,
    cape: 'LocalSkin/capes/{USERNAME}.png',
    elytra: 'LocalSkin/elytras/{USERNAME}.png',
  });
  await atomicJson(file, { ...(existing && typeof existing === 'object' ? existing : {}),
    loadlist });
}

module.exports = { SkinLibrary, validateSkinPng, cleanIndex, configureLocalSkin };
