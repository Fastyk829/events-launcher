'use strict';

const { totalmem } = require('node:os');
const { validGpuPreference } = require('./gpu-preference.cjs');

const MIN_MEMORY_MB = 2048;
const MEMORY_STEP_MB = 512;
const MAX_MEMORY_MB = 16384;
const DEFAULT_MEMORY_MB = 4096;

function memoryLimits(bytes = totalmem()) {
  if (!Number.isFinite(bytes) || bytes <= 0) throw new Error('invalid_system_memory');
  const totalMemoryMb = Math.floor(bytes / 1024 / 1024);
  // Keep at least 2 GB available for Windows and other apps whenever possible.
  const available = Math.max(MIN_MEMORY_MB, totalMemoryMb - 2048);
  const maximumMemoryMb = Math.max(MIN_MEMORY_MB, Math.min(
    MAX_MEMORY_MB, Math.floor(available / MEMORY_STEP_MB) * MEMORY_STEP_MB,
  ));
  return {
    minimumMemoryMb: MIN_MEMORY_MB,
    maximumMemoryMb,
    totalMemoryMb,
    memoryStepMb: MEMORY_STEP_MB,
  };
}

function validMemoryMb(value, limits = memoryLimits()) {
  return Number.isInteger(value)
    && value >= limits.minimumMemoryMb
    && value <= limits.maximumMemoryMb
    && value % MEMORY_STEP_MB === 0;
}

function validNickname(value) {
  return typeof value === 'string' && (value === '' || /^[A-Za-z0-9_]{3,16}$/.test(value));
}

function validJvmArguments(value) {
  return typeof value === 'string' && value.length <= 2000;
}

function normalizeSettings(input, limits = memoryLimits()) {
  const nickname = input && validNickname(input.nickname) ? input.nickname : '';
  const memoryMb = input && validMemoryMb(input.memoryMb, limits)
    ? input.memoryMb
    : Math.min(DEFAULT_MEMORY_MB, limits.maximumMemoryMb);
  const gpuPreference = input && validGpuPreference(input.gpuPreference)
    ? input.gpuPreference : 'automatic';
  const jvmArguments = input && validJvmArguments(input.jvmArguments) ? input.jvmArguments.trim() : '';
  return { nickname, memoryMb, gpuPreference, jvmArguments };
}

function validateSettings(input, limits = memoryLimits()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || !validNickname(input.nickname)) throw new Error('invalid_nickname');
  if (!validMemoryMb(input.memoryMb, limits)) throw new Error('invalid_memory_allocation');
  if (!validGpuPreference(input.gpuPreference)) throw new Error('invalid_gpu_preference');
  if (input.jvmArguments !== undefined && !validJvmArguments(input.jvmArguments)) {
    throw new Error('invalid_jvm_arguments');
  }
  const jvmArguments = typeof input.jvmArguments === 'string' ? input.jvmArguments.trim() : '';
  return { nickname: input.nickname, memoryMb: input.memoryMb, gpuPreference: input.gpuPreference, jvmArguments };
}

module.exports = { memoryLimits, validMemoryMb, validNickname, normalizeSettings, validateSettings };
