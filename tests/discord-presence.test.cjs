'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const net = require('node:net');
const { createDiscordPresence } = require('../src/main/discord-presence.cjs');
test('Discord IPC handshakes, handles fragmented READY, publishes activity and answers ping', t => {
 const socket = new EventEmitter(), sent = [];
 socket.setTimeout = () => {};
 socket.write = bytes => sent.push({ op: bytes.readUInt32LE(0), data: JSON.parse(bytes.subarray(8).toString()) });
 socket.destroy = () => { socket.destroyed = true; socket.emit('close'); };
 t.mock.method(net, 'createConnection', path => { assert.match(path, /discord-ipc-0$/); return socket; });
 const rpc = createDiscordPresence('1569424550335225886');
 try {
  socket.emit('connect');
  assert.equal(sent[0].op, 0);
  assert.equal(sent[0].data.client_id, '1569424550335225886');
  function frame(op, data) {
   const body = Buffer.from(JSON.stringify(data)), header = Buffer.alloc(8);
   header.writeUInt32LE(op); header.writeUInt32LE(body.length, 4);
   return Buffer.concat([header, body]);
  }
  const ready = frame(1, { evt: 'READY' });
  socket.emit('data', ready.subarray(0, 6));
  assert.equal(sent.length, 1);
  socket.emit('data', ready.subarray(6));
  assert.equal(sent.at(-1).data.cmd, 'SET_ACTIVITY');
  rpc.update({ phase: 'running' });
  assert.equal(sent.at(-1).data.args.activity.state, 'Играет в Project War');
  const count = sent.length;
  rpc.update({ phase: 'running' });
  assert.equal(sent.length, count);
  socket.emit('data', frame(3, { ping: true }));
  assert.equal(sent.at(-1).op, 4);
  rpc.update({ phase: 'ready' });
  assert.equal(sent.at(-1).data.args.activity.state, 'В лаунчере');
 } finally { rpc.stop(); }
 assert.equal(socket.destroyed, true);
});
