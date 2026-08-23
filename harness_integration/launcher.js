'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const DEFAULT_PORT_START = 3080;
const DEFAULT_PORT_END = 3099;
const START_TIMEOUT_MS = 90000;
const STOP_TIMEOUT_MS = 15000;
const LOCK_TIMEOUT_MS = 100000;

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      options[name] = next;
      index += 1;
    } else {
      options[name] = true;
    }
  }
  return options;
}

function normalizeHome(value) {
  if (!value) throw new Error('Missing --mixly-home');
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Mixly directory does not exist: ${resolved}`);
  }
  return resolved;
}

function instanceKey(mixlyHome) {
  return crypto.createHash('sha256').update(mixlyHome.toLowerCase()).digest('hex').slice(0, 12);
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporaryPath, filePath);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function contextKey(context) {
  if (!context) return '';
  return [
    path.resolve(String(context.mixlyHome || '')).toLowerCase(),
    String(context.generation || '0'),
    String(context.cdpPort || ''),
    String(context.origin || '')
  ].join('|');
}

// CDP is a transport detail, not a new Harness session. A normal Mixly 4
// build may expose no CDP while an SDK build uses a different port; changing
// that value must not kill an active conversation just because the toolbar
// button was clicked again.
function stableContextKey(context) {
  if (!context) return '';
  return [
    path.resolve(String(context.mixlyHome || '')).toLowerCase(),
    String(context.generation || '0'),
    String(context.origin || '')
  ].join('|');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function canSignal(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function requestHealthy(url, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 500);
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

function probeCdp(port, origin, timeoutMs = 250) {
  return new Promise((resolve) => {
    const request = http.get(`http://127.0.0.1:${port}/json/list`, { timeout: timeoutMs }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        resolve(false);
        return;
      }
      const chunks = [];
      let length = 0;
      response.on('data', (chunk) => {
        length += chunk.length;
        if (length <= 2 * 1024 * 1024) chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          const targets = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(Array.isArray(targets) && targets.some((target) => String(target.url || '').startsWith(origin)));
        } catch (_) {
          resolve(false);
        }
      });
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

async function discoverCdpPort(origin, explicitPort) {
  if (!origin) return explicitPort || '';
  if (explicitPort && await probeCdp(Number(explicitPort), origin, 500)) return String(explicitPort);
  const candidates = [9222];
  for (let port = 9333; port <= 9399; port += 1) candidates.push(port);
  const matches = await Promise.all(candidates.map(async (port) => await probeCdp(port, origin) ? port : null));
  const found = matches.find(Number.isInteger);
  return found ? String(found) : '';
}

function portAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function choosePort(preferredPort) {
  if (preferredPort) {
    const parsed = Number(preferredPort);
    if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
      throw new Error(`Invalid --port value: ${preferredPort}`);
    }
    if (!(await portAvailable(parsed))) throw new Error(`Port ${parsed} is already in use`);
    return parsed;
  }
  for (let port = DEFAULT_PORT_START; port <= DEFAULT_PORT_END; port += 1) {
    if (await portAvailable(port)) return port;
  }
  throw new Error(`No free Harness port in ${DEFAULT_PORT_START}-${DEFAULT_PORT_END}`);
}

function tail(filePath, maxBytes = 12000) {
  try {
    const data = fs.readFileSync(filePath);
    return data.subarray(Math.max(0, data.length - maxBytes)).toString('utf8');
  } catch (_) {
    return '';
  }
}

function runtimePaths(installRoot) {
  const nodePath = process.env.MIXLY_HARNESS_NODE || path.join(installRoot, 'runtime', 'node', 'node.exe');
  const dshCli = path.join(
    installRoot,
    'runtime',
    'dsh-app',
    'node_modules',
    '@deepseek-ai',
    'dsh',
    'lib',
    'bin.js'
  );
  const mcpServer = process.env.MIXLY_MCP_SERVER || path.join(installRoot, 'mcp', 'mixly_mcp_server.js');
  const mcpRouter = path.join(installRoot, 'mcp_router.js');
  const patchPath = path.join(installRoot, 'config', 'mixly-mcp.cordis.yml');
  return { nodePath, dshCli, mcpServer, mcpRouter, patchPath };
}

function assertRuntime(paths) {
  for (const [name, filePath] of Object.entries(paths)) {
    if (!fs.existsSync(filePath)) throw new Error(`Harness ${name} is missing: ${filePath}`);
  }
}

async function reuseRunning(state) {
  if (!state || !canSignal(state.pid) || typeof state.url !== 'string') return false;
  return requestHealthy(state.url);
}

async function acquireLaunchLock(lockPath) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const descriptor = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(descriptor, `${process.pid}\n`, 'utf8');
      return () => {
        try { fs.closeSync(descriptor); } catch (_) { /* already closed */ }
        try { fs.rmSync(lockPath, { force: true }); } catch (_) { /* best effort */ }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (age > LOCK_TIMEOUT_MS + 5000) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch (_) {
        continue;
      }
      await sleep(150);
    }
  }
  throw new Error('另一个 Mixly AI 启动操作仍在进行，请稍后重试。');
}

function terminateProcessTree(pid) {
  if (!canSignal(pid)) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 10000
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch (_) {
    try { process.kill(pid, 'SIGTERM'); } catch (_) { /* process already exited */ }
  }
}

async function stopRunning(state) {
  if (!state || !Number.isInteger(state.pid) || state.pid <= 0) return;
  terminateProcessTree(state.pid);
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const processStopped = !canSignal(state.pid);
    const endpointStopped = !state.url || !(await requestHealthy(state.url, 300));
    if (processStopped && endpointStopped) return;
    await sleep(150);
  }
  throw new Error(`旧的 Mixly AI 进程未能结束 (PID ${state.pid})`);
}

async function startHarnessUnlocked(options, installRoot, stateDir) {
  const mixlyHome = normalizeHome(options['mixly-home']);
  const generation = String(options.generation || '0');
  const statePath = path.join(stateDir, 'instance.json');
  const contextPath = path.join(stateDir, 'active-context.json');
  const responsePath = options.response ? path.resolve(options.response) : null;
  const previous = readJson(statePath);
  const origin = options.origin || process.env.MIXLY_EXPECTED_ORIGIN || '';
  const cdpPort = generation === '4'
    ? await discoverCdpPort(origin, options['cdp-port'] || process.env.MIXLY_CDP_PORT || '')
    : '';
  const activeContext = {
    mixlyHome,
    generation,
    cdpPort,
    origin,
    updatedAt: new Date().toISOString()
  };
  const persistedContext = readJson(contextPath);
  const previousHealthy = await reuseRunning(previous);
  if (
    previousHealthy
    && stableContextKey(previous.activeContext) === stableContextKey(activeContext)
    && stableContextKey(persistedContext) === stableContextKey(activeContext)
  ) {
    const contextRefreshSkipped = contextKey(previous.activeContext) !== contextKey(activeContext);
    // Keep the context pinned to the running Harness. Updating this file with
    // a new CDP port would make the next MCP child disagree with the live
    // conversation, while restarting here would terminate the user's task.
    const result = {
      ...previous,
      ok: true,
      reused: true,
      restarted: false,
      contextRefreshSkipped,
      requestedContext: contextRefreshSkipped ? activeContext : undefined
    };
    if (!contextRefreshSkipped) delete result.requestedContext;
    writeJsonAtomic(statePath, result);
    if (responsePath) writeJsonAtomic(responsePath, result);
    return result;
  }

  const restarted = Boolean(previousHealthy);
  if (previousHealthy) await stopRunning(previous);
  writeJsonAtomic(contextPath, activeContext);

  const paths = runtimePaths(installRoot);
  assertRuntime(paths);
  const preferredPort = options.port || previousHealthy && previous.port;
  const port = await choosePort(preferredPort);
  const url = `http://127.0.0.1:${port}`;
  const stdoutPath = path.join(stateDir, 'harness.stdout.log');
  const stderrPath = path.join(stateDir, 'harness.stderr.log');
  const workspacePath = mixlyHome;
  const dshHome = path.join(stateDir, 'dsh-home');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(dshHome, { recursive: true });
  const stdout = fs.openSync(stdoutPath, 'w');
  const stderr = fs.openSync(stderrPath, 'w');

  const child = spawn(paths.nodePath, [
    paths.dshCli,
    'web',
    '--patch',
    paths.patchPath,
    '--host',
    '127.0.0.1',
    '--port',
    String(port)
  ], {
    cwd: workspacePath,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', stdout, stderr],
    env: {
      ...process.env,
      DSH_HOME: dshHome,
      DSH_PERMISSION_MODE: 'workspace-write',
      DSH_TELEMETRY_DISABLED: '1',
      DSH_TOOLS_MODE: 'native',
      MIXLY_HARNESS_WORKSPACE: workspacePath,
      MIXLY_CONTEXT_FILE: contextPath,
      MIXLY_MCP_NODE: paths.nodePath,
      MIXLY_MCP_ROUTER: paths.mcpRouter,
      MIXLY_MCP_SERVER: paths.mcpServer
    }
  });
  fs.closeSync(stdout);
  fs.closeSync(stderr);
  child.unref();

  const starting = {
    ok: false,
    status: 'starting',
    pid: child.pid,
    port,
    url,
    mixlyHome,
    generation,
    contextKey: contextKey(activeContext),
    restarted,
    startedAt: new Date().toISOString(),
    stdoutPath,
    stderrPath,
    activeContext
  };
  writeJsonAtomic(statePath, starting);

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await requestHealthy(url, 1200)) {
      await sleep(600);
      if (canSignal(child.pid) && await requestHealthy(url, 1200)) {
        const ready = { ...starting, ok: true, status: 'ready', readyAt: new Date().toISOString() };
        writeJsonAtomic(statePath, ready);
        if (responsePath) writeJsonAtomic(responsePath, ready);
        return ready;
      }
    }
    if (!canSignal(child.pid)) break;
    await sleep(350);
  }

  const details = tail(stderrPath) || tail(stdoutPath) || 'Harness exited without log output.';
  throw new Error(`DeepSeek Harness did not become ready at ${url}.\n${details}`);
}

async function startHarness(options) {
  const installRoot = path.resolve(options['install-root'] || __dirname);
  const stateDir = path.join(installRoot, 'state', 'shared');
  const releaseLock = await acquireLaunchLock(path.join(stateDir, 'launch.lock'));
  try {
    return await startHarnessUnlocked(options, installRoot, stateDir);
  } finally {
    releaseLock();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let result;
  try {
    result = await startHarness(options);
  } catch (error) {
    result = {
      ok: false,
      status: 'error',
      message: error.message || String(error),
      failedAt: new Date().toISOString()
    };
    if (options.response) writeJsonAtomic(path.resolve(options.response), result);
    process.exitCode = 1;
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) main();

module.exports = {
  choosePort,
  contextKey,
  stableContextKey,
  discoverCdpPort,
  instanceKey,
  parseArgs,
  requestHealthy,
  runtimePaths,
  stopRunning,
  startHarness
};
