'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPrivateKey, createPublicKey, sign, verify } = require('node:crypto');
const { createLauncherSession } = require('../src/main/launcher-session.cjs');

test('each launch gets a new ephemeral Ed25519 key pair', () => {
  const a = createLauncherSession();
  const b = createLauncherSession();
  assert.equal(a.EVENTS_LAUNCHER_VERSION, require('../package.json').version);
  assert.throws(() => createLauncherSession('bad'), /версия/);
  assert.notEqual(a.EVENTS_LAUNCHER_PUBLIC_KEY, b.EVENTS_LAUNCHER_PUBLIC_KEY);
  assert.notEqual(a.EVENTS_LAUNCHER_PRIVATE_KEY, b.EVENTS_LAUNCHER_PRIVATE_KEY);
  assert.equal(Buffer.from(a.EVENTS_LAUNCHER_PRIVATE_KEY, 'base64').length, 48);
  assert.equal(Buffer.from(a.EVENTS_LAUNCHER_PUBLIC_KEY, 'base64').length, 44);
});

test('launch session signs a nonce bound to the Minecraft nickname', () => {
  const session = createLauncherSession();
  const privateKey = createPrivateKey({
    key: Buffer.from(session.EVENTS_LAUNCHER_PRIVATE_KEY, 'base64'),
    format: 'der', type: 'pkcs8',
  });
  const publicKey = createPublicKey({
    key: Buffer.from(session.EVENTS_LAUNCHER_PUBLIC_KEY, 'base64'),
    format: 'der', type: 'spki',
  });
  const nonce = Buffer.alloc(32, 0x37);
  const payload = Buffer.concat([Buffer.from(`events-launcher/project-war/v2:player123:${session.EVENTS_LAUNCHER_VERSION}:`), nonce]);
  const signature = sign(null, payload, privateKey);
  assert.equal(verify(null, payload, publicKey, signature), true);
  assert.equal(verify(null, Buffer.alloc(32, 0), publicKey, signature), false);
});
