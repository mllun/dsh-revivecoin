/**
 * Builds a tiny, safe self-test coin for dsh-revivecoin.
 *
 * It contains exactly one file — a fake session under `sessions/_selftest/` —
 * so `coin_restore` can be exercised on a live host without touching any real
 * session or config. Run with `node test/make-selftest-coin.mjs`, call
 * `coin_restore(20990101-000000, true)`, then `node test/drop-selftest.mjs`.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { coinFilePath, coinsDir, containerPathFor, dshHome } from '../lib/paths.mjs';

const target = join(dshHome(), 'sessions', '_selftest', 'session-selftest', 'session.v4.jsonl.zstd');
await mkdir(dirname(target), { recursive: true });
await writeFile(target, 'original\n', 'utf8');

const coinId = '20990101-000000';
const coinDir = join(coinsDir(), coinId);
const mapped = containerPathFor(target);
const container = `${mapped.base}/${mapped.rel}`;
const content = 'coin-version\n';
const sha256 = createHash('sha256').update(content, 'utf8').digest('hex');

const file = coinFilePath(coinDir, 'sessions', container);
await mkdir(dirname(file), { recursive: true });
await writeFile(file, content, 'utf8');

const manifest = {
  formatVersion: 1,
  coinId,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  daily: false,
  sessionId: null,
  plugin: { name: 'dsh-revivecoin', config: {} },
  environment: {
    dshHome: dshHome(),
    profile: 'desktop',
    platform: process.platform,
    node: process.version,
  },
  inventory: { plugins: [], configuredPackages: [], counts: { declared: 0, configured: 0, missingOnDisk: 0 } },
  sections: [{ id: 'sessions', title: '会话记录与上下文', roots: [], missingRoots: [], fileCount: 1, copiedCount: 1, bytes: content.length, listedOnly: 0 }],
  files: [{
    section: 'sessions',
    path: target,
    container,
    size: content.length,
    mtimeMs: Date.now(),
    sha256,
    copied: true,
    virtual: false,
    skipReason: null,
  }],
  stats: { fileCount: 1, copiedCount: 1, copiedBytes: content.length, listedOnly: 0 },
  warnings: [],
};
await writeFile(join(coinDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`selftest coin ready: ${coinDir}`);
console.log(`target: ${target}`);
