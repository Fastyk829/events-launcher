'use strict';
const { Agent, interceptors, fetch } = require('undici');
const { setTimeout: delay } = require('node:timers/promises');

function retryable(error, seen = new Set()) {
  if (!error || seen.has(error)) return false;
  seen.add(error);
  if (/ETIMEDOUT|ENETUNREACH|ECONNRESET|ECONNREFUSED|EAI_AGAIN|UND_ERR_(CONNECT_TIMEOUT|SOCKET|HEADERS_TIMEOUT|BODY_TIMEOUT)/.test(error.code || '')) return true;
  if (/checksum not match/i.test(error.message || '')) return true;
  if (/net::ERR_(TIMED_OUT|CONNECTION_TIMED_OUT|CONNECTION_RESET|CONNECTION_CLOSED|NETWORK_CHANGED|INTERNET_DISCONNECTED|NAME_NOT_RESOLVED)/.test(error.message || '')) return true;
  return retryable(error.cause, seen) || (Array.isArray(error.errors) && error.errors.some(e => retryable(e, seen)));
}

async function retryDownload(operation, onRetry, wait = delay) {
  for (let attempt = 1; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (attempt >= 3 || !retryable(error)) throw error;
      onRetry(`Соединение прервано. Повторяем загрузку (${attempt + 1}/3)…`);
      await wait(attempt * 1500);
    }
  }
}

async function withMinecraftDownloads(operation, onRetry) {
  const agent = new Agent({ connections: 6, pipelining: 1,
    connect: { family: 4, timeout: 30_000 }, headersTimeout: 60_000, bodyTimeout: 60_000 });
  const dispatcher = agent.compose(interceptors.retry({ maxRetries: 2, minTimeout: 1000, maxTimeout: 5000 }),
    interceptors.redirect({ maxRedirections: 5 }));
  const options = { dispatcher, assetsDownloadConcurrency: 6,
    librariesDownloadConcurrency: 6, skipPrevalidate: false, skipRevalidate: false,
    rangePolicy: { computeRanges: size => [{ start: 0, end: size - 1 }] },
    fetch: (url, init) => fetch(url, { ...init, dispatcher }) };
  try { return await retryDownload(() => operation(options), message => {
    // New tasks on retry use a smaller queue; valid cached files are retained.
    options.assetsDownloadConcurrency = 2;
    options.librariesDownloadConcurrency = 2;
    onRetry(message);
  }); }
  finally { await agent.close(); }
}

module.exports = { withMinecraftDownloads, retryDownload };
