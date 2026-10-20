/**
 * Removes everything `make-selftest-coin.mjs` created:
 * the fake session directory, the self-test coin, and its backup snapshots.
 *
 * Run: node test/drop-selftest.mjs
 */
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { backupsDir, coinsDir, dshHome } from '../lib/paths.js';

const coinId = '20990101-000000';

await rm(join(dshHome(), 'sessions', '_selftest'), { recursive: true, force: true });
await rm(join(coinsDir(), coinId), { recursive: true, force: true });

let removedBackups = 0;
try {
  for (const name of await readdir(backupsDir())) {
    if (name.startsWith(`${coinId}-`)) {
      await rm(join(backupsDir(), name), { recursive: true, force: true });
      removedBackups += 1;
    }
  }
} catch {
  /* no backups directory: nothing to clean */
}

console.log(`selftest cleaned (coin ${coinId}, ${removedBackups} backup dir(s))`);
