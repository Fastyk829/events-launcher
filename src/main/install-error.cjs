'use strict';

function formatInstallError(error) {
  const seen = new Set();
  const messages = new Set();
  function visit(value, depth = 0) {
    if (value == null || seen.has(value) || depth > 8 || messages.size >= 12) return;
    seen.add(value);
    if (typeof value !== 'object') { messages.add(String(value)); return; }
    const message = value.message || (value.name !== 'AggregateError' ? value.name : '');
    if (message) messages.add([value.code, message].filter(Boolean).join(': '));
    for (const url of Array.isArray(value.urls) ? value.urls.slice(0, 2) : []) {
      try { const parsed = new URL(url); messages.add(parsed.origin + parsed.pathname); } catch {}
    }
    if (Array.isArray(value.errors)) for (const child of value.errors) visit(child, depth + 1);
    visit(value.cause, depth + 1);
  }
  visit(error);
  return [...messages].join(' · ').slice(0, 2400) || 'Неизвестная ошибка установки';
}

module.exports = { formatInstallError };
