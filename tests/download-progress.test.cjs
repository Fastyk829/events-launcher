'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  formatBytes,
  formatBytesPair,
  formatSpeed,
  formatEta,
  DownloadProgressMeter,
} = require('../src/main/download-progress.cjs');

test('formatBytes formats units accurately', () => {
  assert.equal(formatBytes(0), '0 Б');
  assert.equal(formatBytes(500), '500 Б');
  assert.equal(formatBytes(1024), '1 КБ');
  assert.equal(formatBytes(1536), '2 КБ');
  assert.equal(formatBytes(10 * 1024 * 1024), '10.0 МБ');
  assert.equal(formatBytes(1.5 * 1024 * 1024 * 1024), '1.50 ГБ');
});

test('formatBytesPair handles known and unknown totals', () => {
  assert.equal(formatBytesPair(500, 0), '500 Б');
  assert.equal(formatBytesPair(1024 * 1024, 5 * 1024 * 1024), '1.0 / 5.0 МБ');
  assert.equal(formatBytesPair(100 * 1024, 200 * 1024), '100 / 200 КБ');
  assert.equal(formatBytesPair(1024 * 1024 * 1024, 2 * 1024 * 1024 * 1024), '1.00 / 2.00 ГБ');
});

test('formatSpeed formats units correctly', () => {
  assert.equal(formatSpeed(0), '0 Б/с');
  assert.equal(formatSpeed(512), '512 Б/с');
  assert.equal(formatSpeed(650 * 1024), '650 КБ/с');
  assert.equal(formatSpeed(5.4 * 1024 * 1024), '5.4 МБ/с');
});

test('formatEta formats remaining seconds into human readable intervals', () => {
  assert.equal(formatEta(0), '');
  assert.equal(formatEta(2), 'осталось несколько секунд');
  assert.equal(formatEta(25), 'осталось 25 сек');
  assert.equal(formatEta(60), 'осталось 1 мин');
  assert.equal(formatEta(75), 'осталось 1 мин 15 сек');
  assert.equal(formatEta(3600), 'осталось > 1 ч 0 мин');
  assert.equal(formatEta(3720), 'осталось > 1 ч 2 мин');
});

test('DownloadProgressMeter reports initial snapshot and updates with smoothed speed and eta', () => {
  const reports = [];
  const meter = new DownloadProgressMeter({
    label: 'Скачиваем Minecraft 1.21.1',
    total: 100 * 1024 * 1024,
    onProgress: (detail, progress) => reports.push({ detail, progress }),
    minIntervalMs: 0,
  });

  meter.emit();
  assert.equal(reports.length, 1);
  assert.equal(reports[0].detail, 'Скачиваем Minecraft 1.21.1: 0.0 / 100.0 МБ');
  assert.equal(reports[0].progress.downloaded, 0);
  assert.equal(reports[0].progress.total, 100 * 1024 * 1024);
  assert.equal(reports[0].progress.percent, 0);

  // Simulate update
  meter.samples = [{ time: Date.now() - 1000, bytes: 0 }];
  meter.update(10 * 1024 * 1024);

  assert.equal(reports.length, 2);
  const second = reports[1];
  assert.equal(second.progress.downloaded, 10 * 1024 * 1024);
  assert.equal(second.progress.percent, 10);
  assert.ok(second.progress.speed.includes('МБ/с'));
  assert.ok(second.progress.eta.startsWith('осталось '));
  assert.ok(second.detail.includes('Скачиваем Minecraft 1.21.1: 10.0 / 100.0 МБ'));
});
