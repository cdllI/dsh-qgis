/**
 * Check a dsh-qgis bundle before installing it.
 *
 * `ctx.tools.register()` forwards `parameters` verbatim to the model API, so a
 * property map instead of an object-rooted JSON Schema breaks every request
 * with 400 INVALID_REQUEST. This script loads index.js with stub services and
 * validates every tool schema plus the package manifest.
 *
 * Run: node tools/check-plugin.mjs [plugin-dir]
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ALLOWED = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  'description', 'title', 'default', 'examples', '$comment', 'deprecated', 'readOnly', 'writeOnly',
]);
const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'array', 'object', 'json']);
const problems = [];

function checkNode(node, where) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    problems.push(`${where}: must be a schema object`);
    return;
  }
  for (const key of Object.keys(node)) {
    if (!ALLOWED.has(key)) problems.push(`${where}: unsupported keyword "${key}"`);
  }
  if (Object.hasOwn(node, 'type') && !TYPES.has(node.type)) {
    problems.push(`${where}.type: unsupported value ${JSON.stringify(node.type)}`);
  }
  if (Object.hasOwn(node, 'properties')) {
    if (node.type !== 'object') problems.push(`${where}: "properties" requires type: 'object'`);
    for (const [key, child] of Object.entries(node.properties)) checkNode(child, `${where}.properties.${key}`);
  }
  if (Object.hasOwn(node, 'required')) {
    if (!Array.isArray(node.required) || node.required.some((key) => typeof key !== 'string')) {
      problems.push(`${where}.required: must be an array of strings`);
    }
  }
  if (Object.hasOwn(node, 'items')) checkNode(node.items, `${where}.items`);
  if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
    problems.push(`${where}.additionalProperties: must be a boolean`);
  }
}

const dir = path.resolve(process.argv[2] ?? 'dsh-qgis');
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
if (!manifest.dsh?.bundle?.patch) problems.push('package.json: dsh.bundle.patch is missing');
if (!fs.existsSync(path.join(dir, manifest.dsh?.bundle?.patch ?? 'cordis.patch.yml'))) {
  problems.push('package.json: the patch file does not exist');
}
for (const file of ['index.js', 'engine.py', 'skill.md', 'icon.svg']) {
  if (!fs.existsSync(path.join(dir, file))) problems.push(`missing file: ${file}`);
}
for (const locale of ['en', 'zh']) {
  const file = path.join(dir, 'locale', `${locale}.json`);
  try {
    const body = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!body?.meta?.title || !body?.meta?.description) problems.push(`locale/${locale}.json: meta.title/description missing`);
  } catch (error) {
    problems.push(`locale/${locale}.json: ${error.message}`);
  }
}

const registered = [];
const plugin = await import(pathToFileURL(path.join(dir, 'index.js')).href);
plugin.apply(
  {
    get(name) {
      if (name === 'skills') {
        return { register: () => () => {} };
      }
      return undefined;
    },
    effect(callback) {
      try {
        const dispose = callback();
        return typeof dispose === 'function' ? dispose : () => {};
      } catch {
        return () => {};
      }
    },
    tools: {
      register(definition) {
        registered.push(definition);
        return () => {};
      },
    },
    attachments: {
      async saveImage() {
        throw new Error('check-plugin: attachments.saveImage is not exercised');
      },
    },
    webServer: {
      register() {
        return () => {};
      },
    },
  },
  {},
);

for (const definition of registered) {
  const where = `tool "${definition.name}"`;
  if (definition.parameters?.type !== 'object') {
    problems.push(`${where}: parameters is not object-rooted (type=${JSON.stringify(definition.parameters?.type ?? null)})`);
  }
  checkNode(definition.parameters ?? {}, `${where}.parameters`);
  checkNode(definition.output?.schema ?? {}, `${where}.output.schema`);
  if (typeof definition.execute !== 'function') problems.push(`${where}: execute is missing`);
}

console.log(`plugin: ${plugin.name ?? manifest.name}  entry: ${path.join(dir, 'index.js')}`);
console.log(`tools:  ${registered.map((tool) => tool.name).join(', ') || '(none)'}`);
for (const definition of registered) {
  const properties = Object.keys(definition.parameters?.properties ?? {});
  console.log(`  ${definition.name.padEnd(16)} props=[${properties.join(', ')}]`);
}
if (problems.length > 0) {
  console.error('\nFAIL');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log('\nOK: tool schemas and manifest look valid');
