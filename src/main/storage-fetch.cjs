'use strict';

// Time out stalled connections, not an entire multi-gigabyte archive.
async function fetchWithIdleTimeout(fetcher, url, options, idleMs = 60_000, startupMs = idleMs) {
  const abort = new AbortController();
  const expired = new Promise((_resolve, reject) => {
    abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true });
  });
  const bounded = operation => Promise.race([operation, expired]);
  let timer;
  const arm = (timeout = idleMs) => {
    clearTimeout(timer);
    timer = setTimeout(() => abort.abort(Object.assign(new Error('Сервер не передаёт данные'), { code: 'ETIMEDOUT' })), timeout);
  };
  arm(startupMs);
  try {
    const request = Promise.resolve(fetcher(url, { ...options, signal: abort.signal }));
    // A network implementation may not settle its Promise promptly on abort.
    // Release a response arriving after our deadline without blocking fallback.
    void request.then(response => {
      if (abort.signal.aborted) void response.body?.cancel().catch(() => {});
    }, () => {});
    const response = await bounded(request);
    if (!response.body) { clearTimeout(timer); return response; }
    const reader = response.body.getReader();
    const body = new ReadableStream({
      async pull(controller) {
        try {
          const { done, value } = await bounded(reader.read());
          if (done) { clearTimeout(timer); controller.close(); }
          else { arm(); controller.enqueue(value); }
        } catch (error) {
          clearTimeout(timer);
          controller.error(abort.signal.reason || error);
          void reader.cancel(error).catch(() => {});
        }
      },
      cancel(reason) { clearTimeout(timer); abort.abort(reason); void reader.cancel(reason).catch(() => {}); },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (error) { clearTimeout(timer); throw abort.signal.reason || error; }
}

module.exports = { fetchWithIdleTimeout };
