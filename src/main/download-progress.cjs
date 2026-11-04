'use strict';

function formatBytes(bytes) {
  const b = Math.max(0, Number(bytes) || 0);
  if (b >= 1024 * 1024 * 1024) {
    return (b / (1024 * 1024 * 1024)).toFixed(2) + ' ГБ';
  }
  if (b >= 1024 * 1024) {
    return (b / (1024 * 1024)).toFixed(1) + ' МБ';
  }
  if (b >= 1024) {
    return (b / 1024).toFixed(0) + ' КБ';
  }
  return b + ' Б';
}

function formatBytesPair(downloaded, total) {
  const d = Math.max(0, Number(downloaded) || 0);
  const t = Math.max(0, Number(total) || 0);
  if (t <= 0) return formatBytes(d);
  if (t >= 1024 * 1024 * 1024) {
    return (d / (1024 * 1024 * 1024)).toFixed(2) + ' / ' + (t / (1024 * 1024 * 1024)).toFixed(2) + ' ГБ';
  }
  if (t >= 1024 * 1024) {
    return (d / (1024 * 1024)).toFixed(1) + ' / ' + (t / (1024 * 1024)).toFixed(1) + ' МБ';
  }
  if (t >= 1024) {
    return (d / 1024).toFixed(0) + ' / ' + (t / 1024).toFixed(0) + ' КБ';
  }
  return d + ' / ' + t + ' Б';
}

function formatSpeed(bytesPerSec) {
  const s = Math.max(0, Number(bytesPerSec) || 0);
  if (s >= 1024 * 1024) {
    return (s / (1024 * 1024)).toFixed(1) + ' МБ/с';
  }
  if (s >= 1024) {
    return (s / 1024).toFixed(0) + ' КБ/с';
  }
  return Math.round(s) + ' Б/с';
}

function formatEta(seconds) {
  const sec = Math.max(0, Number(seconds) || 0);
  if (!Number.isFinite(sec) || sec <= 0) return '';
  if (sec < 4) return 'осталось несколько секунд';
  if (sec < 60) return `осталось ${Math.ceil(sec)} сек`;
  const minutes = Math.floor(sec / 60);
  const remainingSec = Math.ceil(sec % 60);
  if (minutes < 60) {
    if (remainingSec === 0 || remainingSec === 60) {
      return `осталось ${remainingSec === 60 ? minutes + 1 : minutes} мин`;
    }
    return `осталось ${minutes} мин ${remainingSec} сек`;
  }
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return `осталось > ${hours} ч ${remMin} мин`;
}

class DownloadProgressMeter {
  constructor({ label = '', total = 0, onProgress = null, minIntervalMs = 150 }) {
    this.label = label;
    this.total = Math.max(0, Number(total) || 0);
    this.downloaded = 0;
    this.onProgress = onProgress;
    this.minIntervalMs = minIntervalMs;
    this.startTime = Date.now();
    this.lastReportTime = 0;
    this.samples = [{ time: this.startTime, bytes: 0 }];
    this.speedBytesPerSec = 0;
  }

  setTotal(total) {
    const t = Math.max(0, Number(total) || 0);
    if (t > 0) this.total = t;
  }

  setLabel(label) {
    this.label = label;
  }

  update(downloaded, total) {
    if (typeof total === 'number' && total > 0) {
      this.total = total;
    }
    this.downloaded = Math.max(0, Number(downloaded) || 0);
    const now = Date.now();

    this.samples.push({ time: now, bytes: this.downloaded });
    while (this.samples.length > 2 && now - this.samples[0].time > 2000) {
      this.samples.shift();
    }

    const oldest = this.samples[0];
    const timeDelta = (now - oldest.time) / 1000;
    if (timeDelta >= 0.3) {
      const bytesDelta = this.downloaded - oldest.bytes;
      this.speedBytesPerSec = Math.max(0, bytesDelta / timeDelta);
    }

    if (now - this.lastReportTime >= this.minIntervalMs || (this.total > 0 && this.downloaded >= this.total)) {
      this.lastReportTime = now;
      this.emit();
    }
  }

  add(chunkLength) {
    this.update(this.downloaded + chunkLength);
  }

  getSnapshot() {
    const total = this.total;
    const downloaded = this.downloaded;
    const speed = this.speedBytesPerSec > 0 ? formatSpeed(this.speedBytesPerSec) : '';
    let eta = '';
    if (this.speedBytesPerSec > 1000 && total > downloaded) {
      const remainingBytes = total - downloaded;
      const remainingSec = remainingBytes / this.speedBytesPerSec;
      eta = formatEta(remainingSec);
    }
    const bytesText = formatBytesPair(downloaded, total);
    const percent = total > 0 ? Math.min(100, Math.floor((downloaded / total) * 100)) : 0;

    let detail = this.label;
    const metaParts = [];
    if (speed) metaParts.push(speed);
    if (eta) metaParts.push(eta);
    const metaJoined = metaParts.join(', ');

    if (bytesText) {
      detail += (detail ? ': ' : '') + bytesText;
      if (metaJoined) {
        detail += ` (${metaJoined})`;
      }
    } else if (metaJoined) {
      detail += ` (${metaJoined})`;
    }

    const progress = {
      downloaded,
      total,
      speed,
      eta,
      bytesText,
      percent,
    };

    return { detail, progress };
  }

  emit() {
    if (typeof this.onProgress === 'function') {
      const { detail, progress } = this.getSnapshot();
      this.onProgress(detail, progress);
    }
  }
}

module.exports = {
  formatBytes,
  formatBytesPair,
  formatSpeed,
  formatEta,
  DownloadProgressMeter,
};
