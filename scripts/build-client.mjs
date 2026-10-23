#!/usr/bin/env node
// Build dist/client.js — the browser half of this plugin — into the single
// __ModuleLoader__ module the DSH web shell expects.
//
// Why this exists: the original build delegated to `tsdown`, which was never a
// declared dependency (package.json never listed it) and was invoked through a
// hard-coded absolute path into the machine-local DSH profile, so `npm test`
// died on every machine. This script uses ONLY the TypeScript compiler API,
// which is already an ordinary devDependency, so `npm install` is enough.
//
// What it does: transpile every module the entry reaches (types erased, ES
// syntax lowered to the target, `.ts` specifiers rewritten to `.js`), wrap each
// module in a CommonJS factory, resolve imports statically, and concatenate
// them in post-order inside the DSH module banner. External specifiers
// (`@deepseek-ai/*`, react, react-dom, node builtins) are left to the host's
// `require`. Value exports of the ENTRY module are re-exported from the
// factory result; the client plugin contract is `name` / `inject` / `apply`.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve, relative, posix, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = resolve(root, 'client/index.ts');
const outFile = resolve(root, 'dist/client.js');
const MODULE_ID = 'dsh-agy-provider';
const FORMAT = ts.ScriptTarget.ES2022;
const EXTERNALS = [ /^@deepseek-ai\//, /^react$/, /^react-dom$/, /^react\/jsx-runtime$/ ];

const fail = (message) => {
  console.error(`build-client: ${message}`);
  process.exit(1);
};

const isExternal = (specifier) => EXTERNALS.some((re) => re.test(specifier));
const builtin = (specifier) => specifier.startsWith('node:') || [
  'fs', 'path', 'url', 'util', 'crypto', 'http', 'https', 'stream', 'events',
  'os', 'child_process', 'assert', 'zlib', 'buffer', 'net', 'tty', 'worker_threads',
].includes(specifier.split('/')[0]);

/** Resolve a relative specifier to an on-disk source file, honouring `.ts`-style ones. */
function resolveFile(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [ base, `${base}.ts`, `${base}.tsx`, base.replace(/\.js$/, '.ts') ];
  if (existsSync(base) && !/\.tsx?$/.test(base)) candidates.push(resolve(base, 'index.ts'));
  for (const candidate of candidates) {
    if (/\.tsx?$/.test(candidate) && existsSync(candidate)) return candidate;
  }
  return undefined;
}

const modules = new Map(); // absolute path -> { id, code, deps: Map<specifier, id>, exports: string[] }
const order = [];
const errors = [];

function load(file) {
  const existing = modules.get(file);
  if (existing !== undefined && existing.done) {
    if (existing.inProgress) throw new Error(`import cycle through ${relative(root, file)}`);
    return existing;
  }
  if (existing?.inProgress) throw new Error(`import cycle through ${relative(root, file)}`);
  const id = posix.normalize(relative(root, file).split('\\').join('/')).replace(/\.tsx?$/, '.js');
  const record = existing ?? { id, deps: new Map(), exports: [] };
  modules.set(file, record);
  record.inProgress = true;

  const source = readFileSync(file, 'utf8');
  const { outputText, diagnostics } = ts.transpileModule(source, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: {
      target: FORMAT,
      module: ts.ModuleKind.CommonJS,
      // Resolution happens in resolveFile() below, so no TS resolver is needed
      // here — `require` specifiers are rewritten to bundle ids afterwards.
      verbatimModuleSyntax: false,
      allowImportingTsExtensions: true,
      esModuleInterop: true,
      newLine: ts.NewLineKind.LineFeed,
      inlineSourceMap: false,
    },
  });
  for (const diagnostic of diagnostics ?? []) {
    errors.push(`${relative(root, file)}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`);
  }
  if (outputText === '') fail(`${relative(root, file)} produced no output`);

  // Walk requires in order of appearance so the concatenation is post-order.
  const requireRe = /require\("([^"]+)"\)/g;
  for (const match of outputText.matchAll(requireRe)) {
    const specifier = match[1];
    if (record.deps.has(specifier)) continue;
    if (isExternal(specifier) || builtin(specifier)) {
      record.deps.set(specifier, null);
      continue;
    }
    if (!specifier.startsWith('.')) fail(`${relative(root, file)}: bare import "${specifier}" is not in the external allow-list`);
    const target = resolveFile(file, specifier);
    if (target === undefined) fail(`${relative(root, file)}: cannot resolve "${specifier}"`);
    const child = load(target);
    record.deps.set(specifier, child.id);
  }

  record.code = outputText.replace(/\brequire\("([^"]+)"\)/g, (whole, specifier) => {
    const target = record.deps.get(specifier);
    return target === null ? whole : `require(${JSON.stringify(target)})`;
  });
  record.done = true;
  record.inProgress = false;
  order.push(record);
  return record;
}

/** Names the entry hands back to the host. */
function entryExports(entryRecord) {
  const names = new Set();
  const re = /exports\.([A-Za-z_$][\w$]*)\s*=/g;
  for (const match of entryRecord.code.matchAll(re)) {
    if (match[1] !== '__esModule') names.add(match[1]);
  }
  const def = /Object\.defineProperty\(exports,\s*"([^"]+)"/g;
  for (const match of entryRecord.code.matchAll(def)) {
    if (match[1] !== '__esModule') names.add(match[1]);
  }
  return [ ...names ].sort();
}

let entryRecord;
try {
  entryRecord = load(entry);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
if (errors.length > 0) fail(`transpile errors:\n  ${errors.join('\n  ')}`);

const names = entryExports(entryRecord);
const parts = [ `window.__ModuleLoader__.load({ id: ${JSON.stringify(MODULE_ID)}, factory: (require) => {` ];
parts.push(
  'var __modules = Object.create(null);',
  // DSH hands the factory the host's `require`; internal modules must resolve
  // through __modules instead, so the entry gets a scoped resolver. The inner
  // require must hand back the module's exports object — returning the module
  // function's own (undefined) return value silently breaks every import.
  'var __require = (specifier) => {',
  '  if (specifier in __modules) {',
  '    const inner = __modules[specifier];',
  '    inner(__require, inner.exports ??= {}, inner);',
  '    return inner.exports;',
  '  }',
  '  return require(specifier);',
  '};',
);
for (const record of order) {
  parts.push(`__modules[${JSON.stringify(record.id)}] = function (require, exports, module) {`);  parts.push(record.code.trimEnd());
  parts.push('};');
}
parts.push(
  'var module = { exports: {} }; var exports = module.exports;',
  `__modules[${JSON.stringify(entryRecord.id)}](__require, exports, module);`,
  ...names.map((name) => `exports.${name} = module.exports.${name};`),
  'return module.exports; } });',
  '',
);
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, parts.join('\n'), 'utf8');

const missing = [ 'name', 'inject', 'apply' ].filter((name) => !names.includes(name));
if (missing.length > 0) fail(`entry is missing the client plugin contract: ${missing.join(', ')}`);
console.log(`build-client: ${order.length} modules -> ${relative(root, outFile)} (${Buffer.byteLength(parts.join('\n'))} bytes); exports: ${names.join(', ')}`);
