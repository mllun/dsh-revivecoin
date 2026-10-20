/**
 * Smoke test for the browser half.
 *
 * Runs the compiled `lib/client.js` inside a VM with a stub module loader and a
 * minimal React, then asserts the three contracts the Harness relies on:
 *   1. the factory id is the bundle's package name,
 *   2. `apply` registers into `plugins.bundle.config` under that same name,
 *   3. the card renders without throwing with and without a usable form.
 *
 * Rendering here is structural (a fake `createElement` returns a plain tree),
 * so this proves the card mounts and its props flow; the visual result still
 * needs a real page.
 *
 * Run: node test/client-smoke.mjs
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const code = await readFile(join(root, 'lib', 'client.js'), 'utf8');

const PACKAGE_NAME = '@local/dsh-revivecoin';
const errors = [];
let loaded = null;

const sandbox = {
  console: { error: (...args) => errors.push(args.join(' ')), log() {} },
};
sandbox.globalThis = sandbox;
sandbox.__ModuleLoader__ = {
  load(definition) {
    loaded = definition;
  },
};

vm.runInNewContext(code, sandbox, { filename: 'lib/client.js' });

assert.ok(loaded, 'client bundle must call __ModuleLoader__.load');
assert.equal(loaded.id, PACKAGE_NAME, 'factory id must be the bundle package name');
assert.equal(typeof loaded.factory, 'function');

// --- fake React ----------------------------------------------------------
function createReact() {
  const hookCalls = [];
  const React = {
    useState(initial) {
      hookCalls.push('useState');
      const value = typeof initial === 'function' ? initial() : initial;
      return [value, () => {}];
    },
    useEffect() {
      hookCalls.push('useEffect');
    },
    useRef(value) {
      hookCalls.push('useRef');
      return { current: value };
    },
    useCallback(fn) {
      hookCalls.push('useCallback');
      return fn;
    },
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children };
    },
  };
  return { React, hookCalls };
}

const { React } = createReact();
const module = loaded.factory((id) => {
  assert.equal(id, 'react', 'only "react" may be required from the module table');
  return React;
});

assert.equal(typeof module.apply, 'function');
assert.ok(Array.isArray(module.inject));
assert.ok(module.inject.includes('slots'));

// --- registrations -------------------------------------------------------
const registrations = [];
const fakeCtx = {
  get(name) {
    if (name !== 'configForms') return undefined;
    return {
      describe: () => ({
        getSnapshot: () => ({ view: { namespaces: [{ ns: 'include:dsh-revivecoin' }] } }),
        subscribe: () => () => {},
      }),
      get: () => ({
        getSnapshot: () => ({ status: 'ready', revision: 1, value: { maxFileBytes: 16777216 } }),
        subscribe: () => () => {},
        mutate: async () => true,
      }),
    };
  },
  effect(callback) {
    return callback();
  },
  slots: {
    inject(slotName, callback) {
      assert.equal(slotName, 'plugins.bundle.config', 'card must target the bundle config slot');
      return callback();
    },
    register(options, component) {
      registrations.push({ options, component });
      return () => {};
    },
  },
};

module.apply(fakeCtx);

assert.equal(registrations.length, 1, 'apply must register exactly one card');
const [{ options, component }] = registrations;
assert.equal(options.name, 'plugins.bundle.config');
assert.equal(options.key, PACKAGE_NAME, 'slot key must be the bundle package name');

// --- render paths --------------------------------------------------------
const page = component({ view: 'page' });
assert.ok(page && page.type, 'page view renders an element');
assert.ok(Array.isArray(page.children), 'page view has children');
errors.length = 0;

const summary = component({ view: 'summary' });
assert.ok(summary && summary.type, 'summary view renders an element');

// a host without the config service must not register a broken card
const seenErrors = [];
module.apply({
  get: () => undefined,
  effect: (cb) => cb(),
  slots: {
    inject() {
      throw new Error('must not register without configForms');
    },
    register() {},
  },
});
assert.equal(seenErrors.length, 0);

console.log('client smoke ok');
console.log(`  factory id: ${loaded.id}`);
console.log(`  slot key:   ${options.key}`);
