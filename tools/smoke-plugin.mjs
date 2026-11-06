/**
 * End-to-end smoke test for dsh-qgis without the harness: load index.js with
 * stub services, then drive every tool against the real headless engine.
 *
 * Run: node tools/smoke-plugin.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve('dsh-qgis');
const RUN = path.resolve('.probe', 'run');
fs.mkdirSync(path.join(RUN, 'exports'), { recursive: true });

const plugin = await import(pathToFileURL(path.join(ROOT, 'index.js')).href);
const tools = new Map();

plugin.apply(
  {
    get(name) {
      if (name === 'skills') return { register: () => () => {} };
      return undefined;
    },
    effect(callback) {
      const dispose = callback();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => {}; } },
    attachments: {
      async saveImage({ data, name }) {
        return { id: `smoke-${name}`, width: 0, height: 0, bytes: data.length };
      },
    },
    webServer: { register: () => () => {} },
  },
  {},
);

const exec = { agent: { session: { header: { cwd: RUN, id: 'smoke-session' } } }, signal: undefined };
const run = async (name, args) => {
  const tool = tools.get(name);
  if (!tool) throw new Error(`tool ${name} missing`);
  const started = Date.now();
  const value = await tool.execute(args, exec);
  console.log(`\n=== ${name} (${Date.now() - started} ms) ===`);
  console.log(JSON.stringify(value, (key, item) => (key === 'attachment' ? '<attachment>' : item), 2).slice(0, 2400));
  return value;
};

await run('qgis_status', {});
await run('qgis_scan', { paths: [path.resolve('fixtures')] });
await run('qgis_find', { query: 'buffer' });
await run('qgis_find', { id: 'native:buffer' });

const buffer = await run('qgis_run', {
  algorithm: 'native:buffer',
  parameters: {
    INPUT: path.resolve('fixtures', 'sample_areas.geojson'),
    DISTANCE: 300,
    SEGMENTS: 8,
    OUTPUT: path.join(RUN, 'exports', 'areas_buffer.gpkg'),
  },
});
await run('qgis_check', { path: path.join(RUN, 'exports', 'areas_buffer.gpkg') });
await run('qgis_map', {
  layers: [
    { path: path.resolve('fixtures', 'sample_areas.geojson'), name: '耕地' },
    { path: path.join(RUN, 'exports', 'areas_buffer.gpkg'), name: '300 米缓冲' },
  ],
  title: '研究区耕地缓冲分析',
  subtitle: '300 m buffer',
  source: 'smoke test',
  dpi: 200,
  name: 'smoke-map',
});
await run('qgis_history', { action: 'methods' });
console.log('\nfiles:', fs.readdirSync(path.join(RUN, 'exports')));
process.exit(0);
