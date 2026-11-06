/**
 * QGIS capability for DeepSeek Harness.
 *
 * The GIS work happens in a long-lived PyQGIS process (`engine.py`) that runs
 * under the QGIS-bundled interpreter. No QGIS GUI and no listening port are
 * involved: the engine owns a headless QgsApplication and is driven over JSON
 * lines on stdin/stdout.
 */

import { execFile, spawn } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-qgis';
export const inject = ['tools', 'attachments'];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.join(HERE, 'engine.py');
const MAX_TEXT = 24_000;

function readLocalConfig() {
  try {
    return JSON.parse(fsSync.readFileSync(path.join(HERE, 'qgis.config.json'), 'utf8'));
  } catch {
    return {};
  }
}

function settings(config) {
  const raw = { ...readLocalConfig(), ...(config ?? {}) };
  return {
    qgisDir: typeof raw.qgisDir === 'string' ? raw.qgisDir.trim() : '',
    pythonBat: typeof raw.pythonBat === 'string' ? raw.pythonBat.trim() : '',
    fontDir: typeof raw.fontDir === 'string' && raw.fontDir.trim() ? raw.fontDir.trim() : 'C:\\Windows\\Fonts',
    outDir: typeof raw.outDir === 'string' ? raw.outDir.trim() : '',
    timeoutMs: Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0 ? raw.timeoutMs : 600_000,
    idleMs: Number.isFinite(raw.idleMs) && raw.idleMs > 0 ? raw.idleMs : 600_000,
  };
}

function truncate(value) {
  let text;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  if (text === undefined) return { text: 'null', truncated: false };
  if (text.length <= MAX_TEXT) return { text, truncated: false };
  return { text: `${text.slice(0, MAX_TEXT)}…`, truncated: true };
}

function slugify(value) {
  return String(value ?? 'result')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'result';
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** Locate a QGIS 4 install without assuming a drive letter. */
function discoverQGIS(configDir) {
  const candidates = [];
  if (configDir) candidates.push(configDir);
  if (process.env.QGIS_PREFIX_PATH) candidates.push(path.resolve(process.env.QGIS_PREFIX_PATH, '..', '..'));
  if (process.env.OSGEO4W_ROOT) candidates.push(process.env.OSGEO4W_ROOT);

  const roots = [];
  const scanRoot = (base) => {
    try {
      for (const entry of fsSync.readdirSync(base, { withFileTypes: true })) {
        if (entry.isDirectory() && /^(QGIS|OSGeo4W)/i.test(entry.name)) roots.push(path.join(base, entry.name));
      }
    } catch {
      // an absent drive or a protected directory is not an error
    }
  };
  for (const letter of 'CDEFGHIJ') scanRoot(`${letter}:\\`);
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
    if (base) scanRoot(base);
  }
  candidates.push(...roots);

  for (const dir of candidates) {
    if (!dir) continue;
    const normalized = dir.endsWith(`${path.sep}apps${path.sep}qgis`) ? path.resolve(dir, '..', '..') : dir;
    if (fsSync.existsSync(path.join(normalized, 'bin', 'qgis-bin.exe'))) {
      return normalized;
    }
    if (fsSync.existsSync(path.join(normalized, 'bin', 'qgis.exe'))) {
      return normalized;
    }
  }
  return '';
}

const versionCache = new Map();

/** Async on purpose: execFileSync blocks the Host event loop, which freezes every session. */
function qgisVersion(qgisDir) {
  if (!qgisDir) return Promise.resolve('');
  if (versionCache.has(qgisDir)) return Promise.resolve(versionCache.get(qgisDir));
  return new Promise((resolve) => {
    execFile(
      path.join(qgisDir, 'bin', 'qgis-bin.exe'),
      ['--version'],
      { timeout: 15_000, encoding: 'utf8', windowsHide: true },
      (error, stdout) => {
        const version = error ? '' : String(stdout).split(/\r?\n/)[0].trim();
        versionCache.set(qgisDir, version);
        resolve(version);
      },
    );
  });
}

function grassDirFor(qgisDir) {
  if (!qgisDir) return '';
  const apps = path.join(qgisDir, 'apps', 'grass');
  try {
    for (const name of fsSync.readdirSync(apps)) {
      if (!/^grass/i.test(name)) continue;
      const candidate = path.join(apps, name);
      if (fsSync.existsSync(path.join(candidate, 'etc', 'VERSIONNUMBER'))) return candidate;
    }
  } catch {
    // no GRASS bundled with this install
  }
  return '';
}

export function apply(ctx, config) {
  const cfg = settings(config);

  function outRootFor(exec) {
    let cwd = '';
    try {
      cwd =
        (exec && exec.agent && exec.agent.session && exec.agent.session.header && exec.agent.session.header.cwd) ||
        '';
    } catch {
      cwd = '';
    }
    for (const dir of [cfg.outDir, cwd]) {
      if (typeof dir !== 'string' || dir === '') continue;
      try {
        fsSync.mkdirSync(dir, { recursive: true });
        fsSync.accessSync(dir, fsSync.constants.W_OK);
        return dir;
      } catch {
        // next candidate
      }
    }
    return os.tmpdir();
  }

  function sessionIdFor(exec) {
    try {
      return exec?.agent?.session?.header?.id ?? 'session';
    } catch {
      return 'session';
    }
  }

  /** Engine diagnostics live on the local disk. */
  const AGENT_HOME = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'qgisagent');
  const HOST_LOG = path.join(AGENT_HOME, 'host.log');

  function logHost(line) {
    try {
      fs.mkdir(AGENT_HOME, { recursive: true })
        .then(() => fs.appendFile(HOST_LOG, `${new Date().toISOString()} ${line}\n`, 'utf8'))
        .catch(() => {});
    } catch {
      // diagnostics are best effort
    }
  }

  function historyFileIn(root) {
    return path.join(root, '.qgis-agent', 'history.jsonl');
  }

  // ---- engine process -------------------------------------------------- //

  let child;
  let childPid = 0;
  let buffer = '';
  let sequence = 0;
  let stderrTail = '';
  let readyPromise;
  let readyResolve;
  let readyReject;
  let idleTimer;
  let chain = Promise.resolve();
  const pending = new Map();
  let resolvedDir = '';

  function engineDir() {
    if (resolvedDir && fsSync.existsSync(path.join(resolvedDir, 'bin', 'qgis-bin.exe'))) return resolvedDir;
    resolvedDir = discoverQGIS(cfg.qgisDir);
    return resolvedDir;
  }

  function pythonBatFor(dir) {
    if (cfg.pythonBat) return cfg.pythonBat;
    return path.join(dir, 'bin', 'python-qgis.bat');
  }

  /**
   * `cmd.exe` cannot carry a quoted command line reliably through an argv
   * array, so the batch file path with its spaces goes into a generated
   * wrapper with no spaces in its own path.
   */
  function writeWrapper(dir) {
    const base = process.env.LOCALAPPDATA || os.tmpdir();
    const wrapperDir = path.join(base, 'qgisagent');
    fsSync.mkdirSync(wrapperDir, { recursive: true });
    const wrapper = path.join(wrapperDir, 'run-engine.cmd');
    const content = ['@echo off', `call "${pythonBatFor(dir)}" "${ENGINE}"`, ''].join('\r\n');
    fsSync.writeFileSync(wrapper, content, 'ascii');
    return wrapper;
  }

  function resetReady() {
    readyPromise = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    readyPromise.catch(() => {});
  }

  function settle(line) {
    let reply;
    try {
      reply = JSON.parse(line);
    } catch {
      // Invalid JSON (historically a bare NaN from a raster nodata value) used
      // to be dropped here, leaving the call pending until its timeout. Keep a
      // trace so the next occurrence is visible in host.log.
      logHost(`unparsable engine line (${line.length} chars): ${line.slice(0, 180)}`);
      return;
    }
    if (reply.event === 'ready') {
      logHost(`engine ready ${JSON.stringify(reply.startup ?? {})}`);
      if (readyResolve) readyResolve(reply);
      return;
    }
    const entry = pending.get(reply.id);
    if (!entry) return;
    pending.delete(reply.id);
    clearTimeout(entry.timer);
    if (reply.ok) entry.resolve(reply.result);
    else {
      const error = new Error(reply.error ?? 'QGIS engine failed');
      if (reply.traceback) error.stack = `${error.stack}\n${reply.traceback}`;
      entry.reject(error);
    }
  }

  function scheduleIdle() {
    clearTimeout(idleTimer);
    if (!child) return;
    idleTimer = setTimeout(() => {
      if (pending.size > 0) return scheduleIdle();
      stopWorker();
    }, cfg.idleMs);
    if (idleTimer.unref) idleTimer.unref();
  }

  function ensureWorker() {
    if (child && child.exitCode === null && !child.killed) return child;
    const dir = engineDir();
    if (!dir) {
      throw new Error(
        'QGIS 4 was not found. Install QGIS 4.x, or set "qgisDir" in qgis.config.json ' +
          '(for example "E:\\\\QGIS 4.0.2") and call qgis_status again.',
      );
    }
    const wrapper = writeWrapper(dir);
    resetReady();
    childPid = 0;
    child = spawn('cmd.exe', ['/d', '/c', wrapper], {
      env: {
        ...process.env,
        QT_QPA_PLATFORM: 'offscreen',
        QGIS_AGENT_FONT_DIR: cfg.fontDir,
        GISBASE: process.env.GISBASE || grassDirFor(dir),
        PYTHONIOENCODING: 'utf-8',
        PYTHONUNBUFFERED: '1',
      },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    logHost(`spawn engine pid=${child.pid ?? 0} qgis=${dir} grass=${process.env.GISBASE || grassDirFor(dir) || '-'}`);
    childPid = child.pid ?? 0;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) settle(line);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-4000);
    });
    child.on('error', (error) => {
      if (readyReject) readyReject(error);
      for (const [, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(error);
      }
      pending.clear();
      child = undefined;
    });
    child.on('exit', (code) => {
      const failure = new Error(
        `QGIS engine exited (code ${code})${stderrTail ? `: ${stderrTail.trim().slice(-800)}` : ''}`,
      );
      if (readyReject) readyReject(failure);
      for (const [, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(failure);
      }
      pending.clear();
      child = undefined;
      buffer = '';
    });
    scheduleIdle();
    return child;
  }

  function stopWorker() {
    clearTimeout(idleTimer);
    if (!child) return;
    try {
      child.kill();
    } catch {
      // already gone
    }
    child = undefined;
    buffer = '';
  }

  function doCall(op, args, signal, timeoutMs) {
    const worker = ensureWorker();
    const ready = readyPromise;
    const id = String(++sequence);
    const send = () =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          clearTimeout(timer);
          stopWorker();
          reject(new Error(`QGIS engine timed out after ${timeoutMs} ms during ${op}`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        if (signal) {
          if (signal.aborted) {
            pending.delete(id);
            clearTimeout(timer);
            reject(new Error('aborted'));
            return;
          }
          signal.addEventListener(
            'abort',
            () => {
              const entry = pending.get(id);
              if (!entry) return;
              pending.delete(id);
              clearTimeout(entry.timer);
              entry.reject(new Error('aborted'));
            },
            { once: true },
          );
        }
        worker.stdin.write(`${JSON.stringify({ id, op, args })}\n`, (error) => {
          if (!error) return;
          pending.delete(id);
          clearTimeout(timer);
          reject(error);
        });
      });
    let readyTimer;
    return Promise.race([
      ready.then((info) => {
        clearTimeout(readyTimer);
        return send(info);
      }),
      new Promise((_, reject) => {
        readyTimer = setTimeout(
          () =>
            reject(
              new Error(
                `QGIS engine did not become ready within 180s. Diagnostics: ${HOST_LOG}. ` +
                  'The worker may still be starting; call qgis_status again.',
              ),
            ),
          180_000,
        );
      }),
    ]).then(
      (value) => {
        scheduleIdle();
        return value;
      },
      (error) => {
        scheduleIdle();
        throw error;
      },
    );
  }

  /** Serialize on the engine, but never let a busy queue hide the real deadline. */
  function call(op, args, signal, timeoutMs = cfg.timeoutMs) {
    const enqueuedAt = Date.now();
    const run = chain.then(() => {
      const waited = Date.now() - enqueuedAt;
      if (waited > timeoutMs) {
        throw new Error(
          `QGIS engine is busy: this ${op} call waited ${Math.round(waited / 1000)}s for the worker. ` +
            'Retry after the current operation finishes, or restart the app if nothing is running.',
        );
      }
      return doCall(op, args, signal, timeoutMs - waited);
    });
    chain = run.catch(() => {});
    return run;
  }

  ctx.effect(() => () => stopWorker());

  // ---- scripts, history, helpers --------------------------------------- //

  function scriptsDir(exec) {
    return path.join(outRootFor(exec), 'scripts');
  }

  function exportsDir(exec) {
    return path.join(outRootFor(exec), 'exports');
  }

  function historyFile(exec) {
    return historyFileIn(outRootFor(exec));
  }

  async function recordHistory(exec, entry) {
    const root = outRootFor(exec);
    try {
      const file = historyFileIn(root);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.appendFile(
        file,
        `${JSON.stringify({ ts: new Date().toISOString(), session: sessionIdFor(exec), ...entry })}\n`,
        'utf8',
      );
    } catch {
      // history is best effort
    }
  }

  async function readHistory(exec, limit = 100, all = false) {
    try {
      const text = await fs.readFile(historyFile(exec), 'utf8');
      const entries = text
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter((entry) => entry && (all || entry.session === sessionIdFor(exec)));
      return entries.slice(-limit);
    } catch {
      return [];
    }
  }

  async function writeRunScript(exec, algorithm, parameters) {
    try {
      const dir = scriptsDir(exec);
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, `qgis-${stamp()}-${slugify(algorithm)}.py`);
      const body = [
        '"""Reproduce this step outside DeepSeek Harness.',
        '',
        'Run with the QGIS-bundled interpreter:',
        '    cmd /c "<QGIS>\\bin\\python-qgis.bat" <this file>',
        '"""',
        'import json',
        'import os',
        'import sys',
        '',
        'from qgis.core import QgsApplication',
        '',
        'app = QgsApplication([], False)',
        'app.initQgis()',
        'sys.path.append(os.path.join(os.environ.get("QGIS_PREFIX_PATH", ""), "python", "plugins"))',
        'from processing.core.Processing import Processing',
        'Processing.initialize()',
        '',
        `parameters = ${JSON.stringify(parameters, null, 2)}`,
        `result = Processing.runAlgorithm(${JSON.stringify(algorithm)}, parameters, None, None, None)`,
        'print(json.dumps({key: str(value) for key, value in result.items()}, ensure_ascii=False, indent=2))',
        'app.exitQgis()',
        '',
      ].join('\n');
      await fs.writeFile(file, body, 'utf8');
      return file;
    } catch {
      return '';
    }
  }

  async function saveMapAttachment(file) {
    const bytes = await fs.readFile(file);
    const attachment = await ctx.attachments.saveImage({
      data: new Uint8Array(bytes),
      mediaType: 'image/png',
      name: path.basename(file),
    });
    return { bytes: bytes.length, attachment };
  }

  async function engineStatus(exec) {
    const dir = engineDir();
    const value = await call('status', {}, exec.signal, 120_000);
    const result = { ...value, qgis_dir: dir, qgis_binary_version: await qgisVersion(dir), pid: childPid };
    return result;
  }

  // ---- tools ----------------------------------------------------------- //

  ctx.tools.register({
    name: 'qgis_status',
    description:
      'Check the headless QGIS engine: installed QGIS version, providers, algorithm count, CJK fonts, output folders and ' +
      'the interpreter being used. Call this first, and again whenever another qgis_* tool fails.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ready: { type: 'boolean' },
          qgis_dir: { type: 'string' },
          qgis_version: { type: 'string' },
          algorithm_count: { type: 'integer' },
          providers: { type: 'array', items: { type: 'string' } },
          fonts: { type: 'object', additionalProperties: true },
          exports: { type: 'string' },
          scripts: { type: 'string' },
          error: { type: 'string' },
        },
        required: ['ready', 'qgis_dir', 'exports', 'scripts'],
      },
      render: (_args, value) => {
        const lines = [
          value.ready ? `QGIS engine ready · ${value.qgis_version ?? 'unknown'}` : 'QGIS engine not ready',
          `qgis: ${value.qgis_dir || '(not found)'}`,
        ];
        if (value.algorithm_count !== undefined) lines.push(`algorithms: ${value.algorithm_count}`);
        if (value.providers) lines.push(`providers: ${value.providers.join(', ')}`);
        if (value.fonts) lines.push(`fonts: ${value.fonts.cjk?.join(', ') || '(none)'} in ${value.fonts.dir || '?'}`);
        if (value.grass) {
          lines.push(
            value.grass.available
              ? `grass: ${value.grass.version} @ ${value.grass.gisbase}`
              : 'grass: not configured (grass:* algorithms will refuse)',
          );
        }
        lines.push(`exports: ${value.exports}`);
        if (value.error) lines.push(`error: ${value.error}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(_args, exec) {
      const result = {
        ready: false,
        qgis_dir: engineDir(),
        exports: exportsDir(exec),
        scripts: scriptsDir(exec),
      };
      try {
        const status = await engineStatus(exec);
        Object.assign(result, status, { ready: true });
      } catch (error) {
        result.error = error instanceof Error ? error.message : String(error);
      }
      return result;
    },
  });

  ctx.tools.register({
    name: 'qgis_scan',
    description:
      'Inventory GIS data before touching it: scan files, folders or .qgs/.qgz projects and report every layer with ' +
      'path, driver, CRS, geometry, feature count, fields, extent and size. Use it to learn what data exists instead ' +
      'of guessing paths; also the way to read the layers of an existing QGIS project without opening QGIS.',
    parameters: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files, folders, or .qgs/.qgz project paths to scan.',
        },
        recursive: { type: 'boolean', description: 'Recurse into folders. Default true.' },
        limit: { type: 'integer', description: 'Maximum dataset files to inspect, 1-400. Default 200.' },
      },
      required: ['paths'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          scanned: { type: 'integer' },
          layer_count: { type: 'integer' },
          items: { type: 'array', items: { type: 'object', additionalProperties: true } },
          projects: { type: 'array', items: { type: 'object', additionalProperties: true } },
          errors: { type: 'array', items: { type: 'object', additionalProperties: true } },
          skipped: { type: 'array', items: { type: 'object', additionalProperties: true } },
          truncated: { type: 'boolean' },
        },
        required: ['scanned', 'layer_count', 'items'],
      },
      render: (_args, value) => {
        const rows = (value.items ?? []).map((item) => {
          const count = item.feature_count ?? item.band_count ?? '?';
          const extra = item.kind === 'raster' ? `${item.width}x${item.height}x${item.band_count}` : `${item.geometry} · ${count} features`;
          return `- ${item.name} [${item.kind}] ${item.crs || 'no CRS'} · ${extra}\n  ${item.path}`;
        });
        const projects = (value.projects ?? []).map(
          (project) => `- project ${project.path} (${project.layer_count} layers)`,
        );
        const errors = (value.errors ?? []).map((error) => `- ! ${error.path}: ${error.error}`);
        return [
          {
            type: 'text',
            text: [
              `${value.layer_count} layers from ${value.scanned} dataset(s)`,
              ...projects,
              ...rows,
              ...errors,
              value.truncated ? '(truncated; raise limit to see more)' : '',
            ]
              .filter(Boolean)
              .join('\n'),
          },
        ];
      },
    },
    async execute(args, exec) {
      const paths = Array.isArray(args.paths) ? args.paths.filter((item) => typeof item === 'string') : [];
      if (paths.length === 0) throw new Error('paths must be a non-empty array');
      return call(
        'scan',
        {
          paths,
          recursive: args.recursive !== false,
          limit: Number.isFinite(args.limit) ? args.limit : 200,
        },
        exec.signal,
        180_000,
      );
    },
  });

  ctx.tools.register({
    name: 'qgis_find',
    description:
      'Find the right QGIS processing algorithm, or read its exact parameter list. Search by keyword (English works ' +
      'best: buffer, clip, reproject, join, zonal, interpolate) or pass an algorithm id to get every parameter with ' +
      'type, default, optional flag and enum values. Call this before qgis_run instead of guessing algorithm ids.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword search, for example "buffer" or "zonal statistics".' },
        id: { type: 'string', description: 'Exact algorithm id, for example "native:buffer", to read its parameters.' },
        provider: { type: 'string', description: 'Restrict search to a provider: native, gdal, grass, qgis, saga.' },
        limit: { type: 'integer', description: 'Maximum matches, 1-30. Default 12.' },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          query: { type: 'string' },
          total: { type: 'integer' },
          matches: { type: 'array', items: { type: 'object', additionalProperties: true } },
          help: { type: 'object', additionalProperties: true },
          hint: { type: 'string' },
        },
        required: [],
      },
      render: (_args, value) => {
        if (value.help) {
          const help = value.help;
          const params = (help.parameters ?? []).map((parameter) => {
            const extras = [
              parameter.optional ? 'optional' : 'required',
              parameter.default !== undefined ? `default=${JSON.stringify(parameter.default)}` : '',
              parameter.options ? `values=${parameter.options.join('/')}` : '',
            ]
              .filter(Boolean)
              .join(', ');
            return `- ${parameter.name} (${parameter.type}, ${extras}) ${parameter.description ?? ''}`;
          });
          return [
            {
              type: 'text',
              text: [
                `${help.algorithm} — ${help.name} (${help.group})`,
                help.short_description ?? '',
                '',
                'parameters:',
                ...params,
              ].join('\n'),
            },
          ];
        }
        const rows = (value.matches ?? []).map(
          (match) => `- ${match.id} — ${match.name} (${match.provider})\n  ${match.short_description ?? ''}`,
        );
        return [
          {
            type: 'text',
            text: [`${value.matches?.length ?? 0}/${value.total ?? 0} matches for "${value.query ?? ''}"`, ...rows, value.hint ?? '']
              .filter(Boolean)
              .join('\n'),
          },
        ];
      },
    },
    async execute(args, exec) {
      return call(
        'find',
        {
          query: typeof args.query === 'string' ? args.query : '',
          id: typeof args.id === 'string' ? args.id : '',
          provider: typeof args.provider === 'string' ? args.provider : '',
          limit: Number.isFinite(args.limit) ? args.limit : 12,
        },
        exec.signal,
        120_000,
      );
    },
  });

  ctx.tools.register({
    name: 'qgis_run',
    description:
      'Run one QGIS processing algorithm headlessly. Pass the id from qgis_find and its parameters; output destinations ' +
      'default to files under exports/ when omitted. Returns output paths, feature counts, the algorithm log and a ' +
      'rerunnable Python script. Long jobs block the engine but never a QGIS window.',
    parameters: {
      type: 'object',
      properties: {
        algorithm: { type: 'string', description: 'Algorithm id from qgis_find, for example "native:buffer".' },
        parameters: {
          type: 'object',
          description:
            'Algorithm parameters keyed by their exact names. Layer inputs accept file paths from qgis_scan. Omit destination parameters to let the plugin choose export paths.',
          additionalProperties: true,
        },
        output_dir: { type: 'string', description: 'Directory for default output files. Defaults to <workspace>/exports.' },
        check: { type: 'boolean', description: 'Run qgis_check on the produced vector/raster outputs.' },
      },
      required: ['algorithm'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          algorithm: { type: 'string' },
          outputs: { type: 'object', additionalProperties: true },
          log: { type: 'array', items: { type: 'string' } },
          duration_ms: { type: 'integer' },
          script: { type: 'string' },
          checks: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
        required: ['algorithm', 'outputs'],
      },
      render: (_args, value) => {
        const outputs = Object.entries(value.outputs ?? {}).map(([key, output]) => {
          if (output && typeof output === 'object' && output.kind) {
            return `- ${key}: ${output.kind} layer ${output.feature_count ?? output.band_count ?? ''} features · ${output.crs}`;
          }
          return `- ${key}: ${JSON.stringify(output)}`;
        });
        const log = (value.log ?? []).slice(-6).map((line) => `  ${line}`);
        const checks = (value.checks ?? []).map((check) => {
          const warnings = (check.warnings ?? []).join('; ');
          return `- check ${String(check.path ?? '').split(/[\\/]/).pop()}: ${warnings || 'ok'}`;
        });
        return [
          {
            type: 'text',
            text: [
              `${value.algorithm} finished in ${value.duration_ms ?? '?'} ms`,
              ...outputs,
              ...checks,
              ...log,
              value.script ? `script: ${value.script}` : '',
              value.output_dir ? `output folder: ${value.output_dir}` : '',
            ]
              .filter(Boolean)
              .join('\n'),
          },
        ];
      },
    },
    async execute(args, exec) {
      const algorithm = String(args.algorithm ?? '');
      if (!algorithm) throw new Error('algorithm is required');
      const parameters = args.parameters && typeof args.parameters === 'object' ? args.parameters : {};
      const outputDir =
        typeof args.output_dir === 'string' && args.output_dir.trim()
          ? args.output_dir.trim()
          : exportsDir(exec);
      const result = await call(
        'run',
        { algorithm, parameters, output_dir: outputDir },
        exec.signal,
        cfg.timeoutMs,
      );
      const script = await writeRunScript(exec, algorithm, result.parameters ?? parameters);
      const checks = [];
      if (args.check) {
        for (const output of Object.values(result.outputs ?? {})) {
          const file = typeof output === 'string' ? output : output?.source?.split('|')[0];
          if (typeof file === 'string' && /\.(gpkg|shp|geojson|tif|tiff)$/i.test(file) && fsSync.existsSync(file)) {
            try {
              const check = await call('check', { path: file }, exec.signal, 240_000);
              checks.push({ path: file, ...check });
            } catch (error) {
              checks.push({ path: file, error: error instanceof Error ? error.message : String(error) });
            }
          }
        }
      }
      const value = { ...result, output_dir: outputDir, ...(script ? { script } : {}), ...(checks.length ? { checks } : {}) };
      await recordHistory(exec, {
        tool: 'qgis_run',
        algorithm,
        parameters: result.parameters ?? parameters,
        outputs: result.outputs,
        duration_ms: result.duration_ms,
        script,
      });
      return value;
    },
  });

  ctx.tools.register({
    name: 'qgis_check',
    description:
      'Quality-check a vector or raster before trusting it: CRS, feature count, empty/null/invalid geometries, fields, ' +
      'extent, band statistics and nodata. Use it after qgis_run and before reporting a number or shipping a map.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Dataset path (shapefile, GeoPackage, GeoJSON, GeoTIFF…).' },
        layer: { type: 'string', description: 'Layer name inside a multi-layer dataset such as a GeoPackage.' },
        expected_crs: { type: 'string', description: 'CRS the layer should be in, for example "EPSG:4326".' },
        sample_size: { type: 'integer', description: 'Raster pixels sampled for band statistics. Default 120000.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          layer: { type: 'object', additionalProperties: true },
          warnings: { type: 'array', items: { type: 'string' } },
        },
        required: ['layer', 'warnings'],
      },
      render: (_args, value) => {
        const layer = value.layer ?? {};
        const lines = [
          `${layer.name} · ${layer.kind} · ${layer.crs || 'no CRS'}`,
          layer.feature_count !== undefined
            ? `features: ${layer.feature_count} (sampled ${layer.sampled_features ?? '?'}) · geometry ${layer.geometry}`
            : `raster: ${layer.width}x${layer.height}x${layer.band_count}`,
          `extent: ${(layer.extent ?? []).map((number) => Number(number).toFixed(5)).join(', ')}`,
        ];
        if (layer.fields) lines.push(`fields: ${layer.fields.map((field) => field.name).join(', ')}`);
        if (layer.bands) {
          for (const band of layer.bands) {
            lines.push(
              `band ${band.band}: ${band.min ?? '?'} … ${band.max ?? '?'} mean ${band.mean ?? '?'} nodata ${band.nodata ?? 'none'}`,
            );
          }
        }
        for (const warning of value.warnings ?? []) lines.push(`! ${warning}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args, exec) {
      const file = String(args.path ?? '');
      if (!file) throw new Error('path is required');
      const result = await call(
        'check',
        {
          path: file,
          layer: typeof args.layer === 'string' ? args.layer : undefined,
          expected_crs: typeof args.expected_crs === 'string' ? args.expected_crs : undefined,
          sample_size: Number.isFinite(args.sample_size) ? args.sample_size : undefined,
        },
        exec.signal,
        300_000,
      );
      await recordHistory(exec, { tool: 'qgis_check', path: file, warnings: result.warnings ?? [] });
      return result;
    },
  });

  ctx.tools.register({
    name: 'qgis_map',
    description:
      'Render a print-quality map headlessly: page layout with title, legend, scale bar and north arrow, exported as ' +
      'PNG at the requested dpi and shown in the conversation. Give it layers (paths from qgis_scan or qgis_run) and ' +
      'optionally an extent in the target CRS. This is the way to deliver a figure; there is no QGIS window to screenshot.',
    parameters: {
      type: 'object',
      properties: {
        layers: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Dataset path or QGIS layer uri.' },
              name: { type: 'string', description: 'Display name override.' },
              opacity: { type: 'number', description: 'Layer opacity 0-1.' },
            },
            required: ['path'],
            additionalProperties: false,
          },
          description: 'Layers to draw, bottom to top. One path per item.',
        },
        extent: {
          type: 'array',
          items: { type: 'number' },
          description: 'Map extent [west, south, east, north] in the target CRS. Defaults to the union of layer extents.',
        },
        crs: {
          type: 'string',
          description: 'Target CRS for the map, for example "EPSG:3857" or "EPSG:4547". Default EPSG:3857.',
        },
        title: { type: 'string', description: 'Map title.' },
        subtitle: { type: 'string', description: 'Second line under the title.' },
        source: { type: 'string', description: 'Data source / note line for the footer.' },
        dpi: { type: 'integer', description: 'Output resolution, 96-600. Default 300.' },
        width_mm: { type: 'number', description: 'Page width in millimetres. Default 190.' },
        height_mm: { type: 'number', description: 'Page height in millimetres. Default 140.' },
        legend: { type: 'boolean', description: 'Draw a legend. Default true.' },
        scalebar: { type: 'boolean', description: 'Draw a scale bar. Default true.' },
        north_arrow: { type: 'boolean', description: 'Draw a north arrow. Default true.' },
        pdf: { type: 'boolean', description: 'Also write a PDF next to the PNG.' },
        name: { type: 'string', description: 'File-name stem. Defaults to a timestamp.' },
      },
      required: ['layers'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          path: { type: 'string' },
          paths: { type: 'array', items: { type: 'string' } },
          width: { type: 'integer' },
          height: { type: 'integer' },
          dpi: { type: 'integer' },
          crs: { type: 'string' },
          extent: { type: 'array', items: { type: 'number' } },
          bytes: { type: 'integer' },
          attachment: { type: 'object' },
        },
        required: ['path', 'width', 'height', 'dpi', 'bytes', 'attachment'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            `Rendered ${value.width}x${value.height} at ${value.dpi} dpi → ${value.path}\n` +
            `output folder: ${path.dirname(value.path)}`,
        },
        { type: 'image', attachment: value.attachment },
      ],
    },
    async execute(args, exec) {
      const layers = Array.isArray(args.layers) ? args.layers : [];
      if (layers.length === 0) throw new Error('layers must contain at least one {path}');
      const exports = exportsDir(exec);
      await fs.mkdir(exports, { recursive: true });
      const stem = typeof args.name === 'string' && args.name.trim() ? slugify(args.name) : `qgis-map-${stamp()}`;
      await fs.mkdir(path.join(outRootFor(exec), '.qgis-agent'), { recursive: true });
      const output = path.join(exports, `${stem}.png`);
      const pdf = args.pdf ? path.join(exports, `${stem}.pdf`) : undefined;
      const result = await call(
        'map',
        {
          layers,
          extent: Array.isArray(args.extent) ? args.extent : undefined,
          crs: typeof args.crs === 'string' ? args.crs : undefined,
          title: typeof args.title === 'string' ? args.title : undefined,
          subtitle: typeof args.subtitle === 'string' ? args.subtitle : undefined,
          source: typeof args.source === 'string' ? args.source : undefined,
          dpi: Number.isFinite(args.dpi) ? args.dpi : 300,
          width_mm: Number.isFinite(args.width_mm) ? args.width_mm : undefined,
          height_mm: Number.isFinite(args.height_mm) ? args.height_mm : undefined,
          legend: args.legend !== false,
          scalebar: args.scalebar !== false,
          north_arrow: args.north_arrow !== false,
          pdf,
          output,
        },
        exec.signal,
        300_000,
      );
      const { bytes, attachment } = await saveMapAttachment(result.path);
      await recordHistory(exec, {
        tool: 'qgis_map',
        path: result.path,
        crs: result.crs,
        extent: result.extent,
        layers: layers.map((layer) => layer.path),
      });
      return { ...result, bytes, attachment };
    },
  });

  ctx.tools.register({
    name: 'qgis_history',
    description:
      'Review the QGIS steps already run in this session, list every saved output file with its absolute path, or ' +
      'export the steps as a methods section. action=files answers "where did my results go"; action=methods writes ' +
      'a Markdown file that lists algorithms, parameters, outputs and timings.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'files', 'methods'],
          description: 'List steps, list saved files, or write a methods document.',
        },
        limit: { type: 'integer', description: 'Maximum steps to read, 1-500. Default 100.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          count: { type: 'integer' },
          entries: { type: 'array', items: { type: 'object', additionalProperties: true } },
          files: { type: 'array', items: { type: 'object', additionalProperties: true } },
          dirs: { type: 'array', items: { type: 'string' } },
          path: { type: 'string' },
          markdown: { type: 'string' },
        },
        required: ['count', 'entries'],
      },
      render: (_args, value) => {
        if (value.path) {
          return [{ type: 'text', text: `${value.count} steps written to ${value.path}\n\n${value.markdown ?? ''}` }];
        }
        if (value.files) {
          const rows = value.files.map(
            (file) => `- ${file.path} (${Math.max(1, Math.round(file.bytes / 1024))} KiB)`,
          );
          const dirs = (value.dirs ?? []).map((dir) => `folder: ${dir}`);
          return [
            {
              type: 'text',
              text: [dirs.join('\n'), rows.join('\n') || 'No output files recorded yet.']
                .filter(Boolean)
                .join('\n\n'),
            },
          ];
        }
        const rows = (value.entries ?? []).map((entry, index) => {
          const subject = entry.algorithm ?? entry.path ?? '';
          return `${index + 1}. ${entry.tool} ${subject}${entry.duration_ms ? ` (${entry.duration_ms} ms)` : ''}`;
        });
        return [{ type: 'text', text: rows.length ? rows.join('\n') : 'No QGIS steps recorded in this session yet.' }];
      },
    },
    async execute(args, exec) {
      const entries = await readHistory(exec, Number.isFinite(args.limit) ? args.limit : 100);
      if (args.action === 'files') {
        const candidates = new Set();
        for (const entry of entries) {
          if (typeof entry.path === 'string') candidates.add(entry.path);
          if (typeof entry.script === 'string') candidates.add(entry.script);
          for (const output of Object.values(entry.outputs ?? {})) {
            const file = typeof output === 'string' ? output : output?.source?.split('|')[0];
            if (typeof file === 'string') candidates.add(file);
          }
        }
        const files = [];
        for (const file of candidates) {
          if (!/^[A-Za-z]:[\\/]/.test(file)) continue;
          try {
            const stat = await fs.stat(file);
            files.push({ path: file, bytes: stat.size, modified: stat.mtime.toISOString() });
          } catch {
            // deleted since the step ran
          }
        }
        files.sort((left, right) => left.path.localeCompare(right.path));
        const dirs = [...new Set(files.map((file) => path.dirname(file.path)))];
        return { count: entries.length, entries, files, dirs };
      }
      if (args.action !== 'methods') {
        return { count: entries.length, entries };
      }
      const lines = [
        '# Spatial analysis methods',
        '',
        `- Tool: DeepSeek Harness + QGIS headless engine (dsh-qgis ${new Date().toISOString().slice(0, 10)})`,
        `- Steps: ${entries.length}`,
        '',
      ];
      entries.forEach((entry, index) => {
        lines.push(`## Step ${index + 1} — ${entry.tool}${entry.algorithm ? ` · ${entry.algorithm}` : ''}`);
        lines.push('');
        lines.push(`- Time: ${entry.ts}`);
        if (entry.algorithm) lines.push(`- Algorithm: \`${entry.algorithm}\``);
        if (entry.parameters) {
          lines.push('- Parameters:');
          lines.push('```json');
          lines.push(JSON.stringify(entry.parameters, null, 2));
          lines.push('```');
        }
        if (entry.path) lines.push(`- ${entry.tool === 'qgis_check' ? 'Path' : 'Output'}: \`${entry.path}\``);
        if (entry.outputs) {
          for (const [key, output] of Object.entries(entry.outputs)) {
            const value = typeof output === 'string' ? output : output?.source ?? JSON.stringify(output);
            lines.push(`- ${key}: \`${value}\``);
          }
        }
        if (entry.duration_ms) lines.push(`- Duration: ${entry.duration_ms} ms`);
        if (entry.script) lines.push(`- Script: \`${entry.script}\``);
        lines.push('');
      });
      const dir = exportsDir(exec);
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, `methods-${stamp()}.md`);
      const markdown = lines.join('\n');
      await fs.writeFile(file, markdown, 'utf8');
      return { count: entries.length, entries, path: file, markdown };
    },
  });

  // ---- skill ----------------------------------------------------------- //

  const skills = ctx.get('skills');
  if (skills) {
    try {
      const content = fsSync.readFileSync(path.join(HERE, 'skill.md'), 'utf8');
      ctx.effect(() =>
        skills.register({
          name: 'qgis',
          description:
            'QGIS editing and spatial analysis: inventory data, find processing algorithms, run them, quality-check outputs, render publication maps.',
          whenToUse:
            'Any vector or raster GIS task: buffer, clip, overlay, reproject, join attributes, zonal statistics, interpolation, map figures.',
          content,
          source: 'runtime',
        }),
      );
    } catch {
      // The skill is optional; the tools still work without it.
    }
  }
}
