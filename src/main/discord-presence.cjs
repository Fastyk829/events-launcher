'use strict';
const net = require('node:net');
const { randomUUID } = require('node:crypto');
function activityFor(phase, start) {
  const states = { running: 'Играет в Project War', launching: 'Готовится к игре', installing: 'Готовится к игре', 'installing-pack': 'Готовится к игре', 'checking-pack': 'Готовится к игре' };
  return { details: 'Minecraft • Project War', state: states[phase] || 'В лаунчере', timestamps: { start }, instance: false };
}
function createDiscordPresence(clientId) {
  let socket, timer, stopped = false, ready = false, index = 0, phase = 'idle', start = Math.floor(Date.now() / 1000), lastPhase;
  function send(op, data) {
    if (!socket || socket.destroyed) return;
    const body = Buffer.from(JSON.stringify(data));
    const header = Buffer.alloc(8); header.writeUInt32LE(op); header.writeUInt32LE(body.length, 4);
    socket.write(Buffer.concat([header, body]));
  }
  function publish() {
    if (ready) send(1, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity: activityFor(phase, start) }, nonce: randomUUID() });
  }
  function connect() {
    if (stopped || process.platform !== 'win32' || !/^\d{17,22}$/.test(clientId || '')) return;
    ready = false;
    let buffer = Buffer.alloc(0);
    const current = socket = net.createConnection('\\\\.\\pipe\\discord-ipc-' + index);
    current.setTimeout(10_000, () => current.destroy());
    current.on('connect', () => send(0, { v: 1, client_id: clientId }));
    current.on('error', () => {});
    current.on('close', () => {
      if (socket !== current) return;
      ready = false; socket = null;
      index = (index + 1) % 10;
      if (!stopped) { timer = setTimeout(connect, index ? 500 : 15_000); timer.unref(); }
    });
    current.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 8) {
        const op = buffer.readUInt32LE(0), length = buffer.readUInt32LE(4);
        if (length > 1024 * 1024) { current.destroy(); return; }
        if (buffer.length < 8 + length) return;
        let data;
        try { data = JSON.parse(buffer.subarray(8, 8 + length).toString()); } catch { current.destroy(); return; }
        buffer = buffer.subarray(8 + length);
        if (op === 2) { current.destroy(); return; }
        if (op === 3) send(4, data);
        if (op === 1 && data.evt === 'READY') { ready = true; current.setTimeout(0); publish(); }
      }
    });
  }
  connect();
  return {
    update(state) {
      phase = state.phase;
      if (lastPhase === phase) return;
      if ((phase === 'running') !== (lastPhase === 'running')) start = Math.floor(Date.now() / 1000);
      lastPhase = phase; publish();
    },
    stop() { stopped = true; clearTimeout(timer); socket?.destroy(); socket = null; },
  };
}
module.exports = { createDiscordPresence, activityFor };
