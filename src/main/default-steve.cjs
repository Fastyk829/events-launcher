'use strict';

const { join } = require('node:path');
const { stat } = require('node:fs/promises');
const yauzl = require('yauzl');

const STEVE_ENTRY = 'assets/minecraft/textures/entity/player/wide/steve.png';
const MAX_STEVE_BYTES = 256 * 1024;

/**
 * Extracts the actual modern Steve skin from the official, already installed
 * Minecraft 1.21.1 client archive. Does not download or redistribute Mojang
 * artwork and does not ship or draw a placeholder skin.
 */
async function loadDefaultSteve(minecraftRoot, version = '1.21.1') {
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(version)) throw new Error('Invalid Minecraft version');
  const jar = join(minecraftRoot, 'versions', version, version + '.jar');
  const metadata = await stat(jar).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!metadata?.isFile()) return null;

  return new Promise((resolve, reject) => {
    yauzl.open(jar, { lazyEntries: true, autoClose: true }, (error, zip) => {
      if (error) return reject(error);
      let finished = false;
      const finish = (failure, value = null) => {
        if (finished) return;
        finished = true;
        zip.close();
        if (failure) reject(failure);
        else resolve(value);
      };
      zip.on('error', finish);
      zip.on('end', () => finish(null));
      zip.on('entry', (entry) => {
        if (entry.fileName !== STEVE_ENTRY) {
          zip.readEntry();
          return;
        }
        if (entry.uncompressedSize < 100 || entry.uncompressedSize > MAX_STEVE_BYTES) {
          finish(new Error('Некорректный размер текстуры Steve в Minecraft'));
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) return finish(streamError);
          const chunks = [];
          let length = 0;
          stream.on('data', (chunk) => {
            length += chunk.length;
            if (length > MAX_STEVE_BYTES) {
              stream.destroy(new Error('Слишком большая текстура Steve'));
              return;
            }
            chunks.push(chunk);
          });
          stream.once('error', finish);
          stream.once('end', () => {
            const bytes = Buffer.concat(chunks);
            if (bytes.length < 33 ||
              !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
              bytes.toString('ascii', 12, 16) !== 'IHDR' ||
              bytes.readUInt32BE(16) !== 64 ||
              bytes.readUInt32BE(20) !== 64) {
              finish(new Error('Minecraft содержит неподдерживаемую текстуру Steve'));
              return;
            }
            finish(null, 'data:image/png;base64,' + bytes.toString('base64'));
          });
        });
      });
      zip.readEntry();
    });
  });
}

module.exports = { loadDefaultSteve, STEVE_ENTRY };
