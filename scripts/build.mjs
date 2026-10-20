/**
 * Build the two halves of the plugin.
 *
 *   src/index.ts + src/*.ts   ->  lib/*.js        (Host half, ESM)
 *   src/client/index.tsx      ->  lib/client.js   (browser half, loader script)
 *
 * The client half is compiled as a plain script (no import/export), so its
 * output stays a `window.__ModuleLoader__.load({...})` call the Harness can
 * fetch and evaluate; `require` only ever appears inside the factory.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
process.chdir(root);

function runTsc(config) {
  const explicit = process.env.TSC_JS;
  if (explicit && existsSync(explicit)) {
    execFileSync(process.execPath, [explicit, '-p', config], { stdio: 'inherit' });
    return;
  }
  const bin = process.platform === 'win32'
    ? join('node_modules', '.bin', 'tsc.cmd')
    : join('node_modules', '.bin', 'tsc');
  if (!existsSync(bin)) {
    throw new Error('tsc not found: install devDependencies (npm install) or set TSC_JS to typescript/bin/tsc');
  }
  execFileSync(bin, ['-p', config], { stdio: 'inherit', shell: process.platform === 'win32' });
}

console.log('[build] host half');
runTsc('tsconfig.json');

console.log('[build] client half');
runTsc('tsconfig.client.json');
const compiledClient = join(root, 'lib', 'client', 'index.js');
if (!existsSync(compiledClient)) {
  throw new Error(`client build produced no ${compiledClient}`);
}
copyFileSync(compiledClient, join(root, 'lib', 'client.js'));
rmSync(join(root, 'lib', 'client'), { recursive: true, force: true });

console.log('[build] done: lib/index.js + lib/client.js');
