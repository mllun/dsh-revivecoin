/**
 * Human-readable operation log for dsh-revivecoin.
 *
 * Every tool call appends one line; a failed step logs the readable reason
 * before the error reaches the model. Logging never throws: a full disk or a
 * locked file must not turn a working command into a failing one.
 *
 * Format: `2026-10-21 03:15:22 [INFO ] coin_create | message`
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { logFile } from './paths.mjs';

/** Rotate the log once it grows past this size. */
const MAX_BYTES = 4 * 1024 * 1024;

function timestamp(date = new Date()) {
  const p2 = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p2(date.getMonth() + 1)}-${p2(date.getDate())} `
    + `${p2(date.getHours())}:${p2(date.getMinutes())}:${p2(date.getSeconds())}`;
}

function rotateIfNeeded(file) {
  try {
    if (!existsSync(file)) return;
    if (statSync(file).size < MAX_BYTES) return;
    renameSync(file, `${file}.1`);
  } catch {
    /* rotation is best effort */
  }
}

/**
 * Append one log line and return it.
 * @param {'INFO'|'WARN'|'ERROR'} level
 * @param {string} scope short operation name, e.g. `coin_create`
 * @param {string} message human-readable text
 */
export function logLine(level, scope, message) {
  const line = `${timestamp()} [${String(level).padEnd(5)}] ${scope} | ${message}\n`;
  try {
    const file = logFile();
    mkdirSync(dirname(file), { recursive: true });
    rotateIfNeeded(file);
    appendFileSync(file, line, 'utf8');
  } catch {
    /* never let logging break the caller */
  }
  return line;
}

export function logInfo(scope, message) {
  return logLine('INFO', scope, message);
}

export function logWarn(scope, message) {
  return logLine('WARN', scope, message);
}

export function logError(scope, message) {
  return logLine('ERROR', scope, message);
}

/** Path shown in tool output so the user can open the log. */
export function logPath() {
  return logFile();
}
