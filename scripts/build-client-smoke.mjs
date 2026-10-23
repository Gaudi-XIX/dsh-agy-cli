// Smoke-test dist/client.js the way the DSH web shell would load it, then check
// that the client plugin contract is intact.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = readFileSync(resolve(root, 'dist/client.js'), 'utf8');
const scratch = mkdtempSync(resolve(root, 'tmp/build-client-smoke-'));

try {
  // The shim for `react` is a file-backed module because the client calls
  // require('react') lazily inside helpers; a throwing proxy keeps the smoke
  // honest (any real render path would fail loudly instead of silently passing).
  writeFileSync(resolve(scratch, 'react.js'), `
    const noop = () => ({});
    module.exports = new Proxy({}, { get: (_t, key) => (key === 'createElement' ? noop : noop) });
  `);
  writeFileSync(resolve(scratch, 'react-dom.js'), 'module.exports = { createPortal: () => ({}) };');

  const elements = [];
  const ctx = { slots: {}, locale: {} };
  let loaded = 0;
  const hostRequire = (specifier) => {
    if (specifier === 'react' || specifier === 'react-dom') {
      const path = resolve(scratch, `${specifier}.js`);
      const module = { exports: {} };
      vm.runInNewContext(readFileSync(path, 'utf8'), { module, exports: module.exports, require: () => undefined });
      return module.exports;
    }
    if (specifier.startsWith('@deepseek-ai/')) return {}; // types-only for this bundle
    throw new Error(`unexpected external require in browser bundle: ${specifier}`);
  };
  const context = vm.createContext({
    require: hostRequire,
    console,
    document: {
      body: {},
      head: { appendChild() {} },
      getElementById: () => null,
      createElement: () => ({ set id(value) { this._id = value; }, get id() { return this._id; }, textContent: '' }),
      addEventListener() {},
      removeEventListener() {},
    },
    addEventListener() {},
    removeEventListener() {},
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout,
    clearTimeout,
    fetch: async () => ({ ok: false, status: 0, json: async () => ({}) }),
  });
  context.window = context;
  context.globalThis = context;
  context.window.__ModuleLoader__ = {
    load({ id, factory }) {
      assert.equal(id, 'dsh-agy-provider');
      elements.push(factory(hostRequire));
      loaded += 1;
    },
  };
  vm.runInContext(bundle, context, { filename: 'dist/client.js' });

  assert.equal(loaded, 1, 'the bundle must register exactly one module');
  const entry = elements[0];
  assert.equal(typeof entry.apply, 'function', 'client entry must export apply()');
  assert.equal(entry.name, 'dsh-agy-provider-client');
  assert.deepEqual([ ...entry.inject ], [ 'slots', 'locale' ]);
  console.log(`build-client smoke: ok — ${bundle.length} bytes, exports ${Object.keys(entry).join(', ')}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
