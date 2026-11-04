'use strict';

const { generateKeyPairSync } = require('node:crypto');

/**
 * Fresh, non-persistent proof for each game process.
 * This is a compatibility filter against unmodified third-party launchers,
 * NOT cryptographic attestation of Events Launcher itself: a modified
 * client can generate an equivalent key and produce the same proof.
 */
function createLauncherSession(version = require('../../package.json').version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(version)) {
    throw new Error('Некорректная версия лаунчера');
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    publicKeyEncoding: { type: 'spki', format: 'der' },
  });
  return {
    EVENTS_LAUNCHER_VERSION: version,
    EVENTS_LAUNCHER_PRIVATE_KEY: privateKey.toString('base64'),
    EVENTS_LAUNCHER_PUBLIC_KEY: publicKey.toString('base64'),
  };
}

module.exports = { createLauncherSession };
