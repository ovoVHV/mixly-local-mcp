'use strict';

const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const NODE_VERSION = '24.19.0';
const DSH_VERSION = '0.1.0-rc.6';
const NODE_ARCHIVE = `node-v${NODE_VERSION}-win-x64.zip`;
const NODE_URLS = [
  `https://npmmirror.com/mirrors/node/v${NODE_VERSION}/${NODE_ARCHIVE}`,
  `https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}`
];
const DEFAULT_NPM_REGISTRY = 'https://registry.npmmirror.com';

function parseArgs(argv) {
  const options = { mixly2: [], mixly3: [], mixly4: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === '--install-root' && value) {
      options.installRoot = value;
      index += 1;
    } else if (key === '--mcp-source' && value) {
      options.mcpSource = value;
      index += 1;
    } else if (key === '--mixly2-home' && value) {
      options.mixly2.push(value);
      index += 1;
    } else if (key === '--mixly3-home' && value) {
      options.mixly3.push(value);
      index += 1;
    } else if (key === '--mixly4-home' && value) {
      options.mixly4.push(value);
      index += 1;
    } else if (key === '--skip-runtime') {
      options.skipRuntime = true;
    }
  }
  return options;
}

function copyFile(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function copyTree(source, destination) {
  if (!fs.existsSync(source)) throw new Error(`Source directory does not exist: ${source}`);
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) copyFile(from, to);
  }
}

let progressLength = 0;

function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return '? B';
  if (value < 1024) return `${value.toFixed(0)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const rounded = Math.ceil(seconds);
  const minutes = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function compactProgressText(value) {
  return String(value || '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(-110);
}

function progressLine(label, completed, total, detail = '') {
  const width = 24;
  const hasTotal = Number.isFinite(total) && total > 0;
  const ratio = hasTotal ? Math.max(0, Math.min(1, completed / total)) : 0;
  const percent = hasTotal ? `${(ratio * 100).toFixed(1).padStart(5)}%` : ' --.-%';
  const filled = hasTotal ? Math.round(width * ratio) : 0;
  const bar = `${'='.repeat(filled)}${hasTotal && filled < width ? '>' : ''}${' '.repeat(Math.max(0, width - filled - (hasTotal && filled < width ? 1 : 0)))}`;
  const line = `${label} [${bar}] ${percent}${detail ? ` ${detail}` : ''}`;
  process.stdout.write(`\r${line}${' '.repeat(Math.max(0, progressLength - line.length))}`);
  progressLength = line.length;
}

function finishProgress() {
  if (progressLength > 0) process.stdout.write('\n');
  progressLength = 0;
}

function stageProgress(label, percent, detail = '') {
  finishProgress();
  process.stdout.write(`${label} [${String(percent).padStart(3)}%]${detail ? ` ${detail}` : ''}\n`);
}

function download(url, destination, label = 'Downloading') {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      finishProgress();
      fs.rmSync(destination, { force: true });
      reject(error);
    };
    const request = https.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        download(new URL(response.headers.location, url).toString(), destination, label).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        fail(new Error(`Download failed (${response.statusCode}): ${url}`));
        return;
      }

      const total = Number(response.headers['content-length'] || 0);
      let downloaded = 0;
      let lastUpdate = 0;
      const startedAt = Date.now();
      const output = fs.createWriteStream(destination);
      response.on('data', (chunk) => {
        downloaded += chunk.length;
        const now = Date.now();
        if (now - lastUpdate < 100 && downloaded !== total) return;
        lastUpdate = now;
        const elapsed = Math.max(0.001, (now - startedAt) / 1000);
        const speed = downloaded / elapsed;
        const eta = total > 0 && speed > 0 ? `ETA ${formatDuration((total - downloaded) / speed)}` : '';
        progressLine(label, downloaded, total, `${formatBytes(downloaded)} / ${total > 0 ? formatBytes(total) : '?'} at ${formatBytes(speed)}/s${eta ? ` ${eta}` : ''}`);
      });
      response.on('error', fail);
      output.on('error', fail);
      output.on('finish', () => {
        if (settled) return;
        settled = true;
        progressLine(label, total || downloaded, total || downloaded, `${formatBytes(downloaded)} complete`);
        finishProgress();
        output.close(resolve);
      });
      response.pipe(output);
    });
    request.on('error', fail);
  });
}

function runStreaming(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const startedAt = Date.now();
    let outputBytes = 0;
    let output = '';
    let lastMessage = 'waiting for process output';
    let lastOutputAt = Date.now();
    let finished = false;
    const idleTimeoutMs = options.idleTimeoutMs || 0;
    const update = () => {
      const elapsed = (Date.now() - startedAt) / 1000;
      progressLine(options.label || path.basename(command), 0, 0, `${elapsed.toFixed(0)}s, output ${formatBytes(outputBytes)}, ${lastMessage}`);
      if (!finished && idleTimeoutMs > 0 && Date.now() - lastOutputAt >= idleTimeoutMs) {
        child.kill();
        finished = true;
        clearInterval(timer);
        finishProgress();
        reject(new Error(`${options.label || path.basename(command)} produced no output for ${Math.round(idleTimeoutMs / 1000)} seconds`));
      }
    };
    const timer = setInterval(update, 500);
    const onData = (chunk) => {
      outputBytes += chunk.length;
      lastOutputAt = Date.now();
      const text = chunk.toString();
      const messages = text.split(/[\r\n]+/).map(compactProgressText).filter(Boolean);
      if (messages.length > 0) lastMessage = messages[messages.length - 1];
      output += text;
      if (output.length > 12000) output = output.slice(-12000);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (error) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      finishProgress();
      reject(error);
    });
    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      finishProgress();
      if (code !== 0) reject(new Error(`${path.basename(command)} failed (${code})\n${output}`));
      else resolve(output);
    });
  });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: 'utf8',
    windowsHide: true,
    stdio: options.capture ? 'pipe' : 'inherit'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} failed (${result.status})\n${result.stderr || result.stdout || ''}`);
  }
  return result.stdout || '';
}

async function ensureNodeRuntime(installRoot) {
  const runtimeRoot = path.join(installRoot, 'runtime');
  const nodeRoot = path.join(runtimeRoot, 'node');
  const nodePath = path.join(nodeRoot, 'node.exe');
  if (fs.existsSync(nodePath)) {
    const version = run(nodePath, ['--version'], { capture: true }).trim();
    if (version === `v${NODE_VERSION}`) {
      stageProgress('Install progress', 50, `Node.js ${version} already available`);
      return nodePath;
    }
    const backup = path.join(runtimeRoot, `node-backup-${Date.now()}`);
    fs.renameSync(nodeRoot, backup);
  }

  const downloads = path.join(installRoot, 'downloads');
  const archivePath = path.join(downloads, NODE_ARCHIVE);
  if (!fs.existsSync(archivePath)) {
    stageProgress('Install progress', 5, `Downloading Node.js v${NODE_VERSION} x64`);
    let lastError;
    for (const [index, url] of NODE_URLS.entries()) {
      try {
        process.stdout.write(`Node.js source: ${new URL(url).host}${index === 0 ? ' (China mirror)' : ' (official fallback)'}\n`);
        await download(url, archivePath, 'Node.js download');
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        finishProgress();
        if (index < NODE_URLS.length - 1) {
          process.stdout.write(`Mirror download failed; trying official Node.js source. ${error.message}\n`);
        }
      }
    }
    if (lastError) throw lastError;
  } else {
    stageProgress('Install progress', 35, 'Node.js archive already downloaded');
  }
  const extractRoot = path.join(runtimeRoot, `node-extract-${process.pid}`);
  fs.mkdirSync(extractRoot, { recursive: true });
  stageProgress('Install progress', 40, 'Extracting Node.js');
  run('tar.exe', ['-xf', archivePath, '-C', extractRoot]);
  const extracted = path.join(extractRoot, `node-v${NODE_VERSION}-win-x64`);
  if (!fs.existsSync(path.join(extracted, 'node.exe'))) {
    throw new Error(`Node archive did not contain the expected directory: ${extracted}`);
  }
  fs.renameSync(extracted, nodeRoot);
  fs.rmSync(extractRoot, { recursive: true, force: true });
  stageProgress('Install progress', 50, `Node.js v${NODE_VERSION} ready`);
  return nodePath;
}

async function ensureDshRuntime(installRoot, nodePath) {
  const appRoot = path.join(installRoot, 'runtime', 'dsh-app');
  const packagePath = path.join(appRoot, 'package.json');
  const cliPath = path.join(appRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  fs.mkdirSync(appRoot, { recursive: true });
  fs.writeFileSync(packagePath, `${JSON.stringify({
    name: 'mixly-deepseek-harness-runtime',
    private: true,
    version: '1.0.0',
    dependencies: { '@deepseek-ai/dsh': DSH_VERSION }
  }, null, 2)}\n`, 'utf8');

  const bundledLockPath = path.join(__dirname, 'dsh-package-lock.json');
  const lockPath = path.join(appRoot, 'package-lock.json');
  if (fs.existsSync(bundledLockPath)) {
    let needsLock = !fs.existsSync(lockPath);
    if (!needsLock) {
      try {
        const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        needsLock = !lock.packages || !lock.packages['node_modules/@deepseek-ai/dsh'];
      } catch {
        needsLock = true;
      }
    }
    if (needsLock) copyFile(bundledLockPath, lockPath);
  }

  const requiredRuntimeModules = [
    path.join(appRoot, 'node_modules', '@deepseek-ai', 'cordis-plugin-group', 'package.json')
  ];
  const runtimeComplete = fs.existsSync(cliPath) && requiredRuntimeModules.every((filePath) => fs.existsSync(filePath));
  if (!runtimeComplete) {
    stageProgress('Install progress', 55, `Installing DeepSeek Harness ${DSH_VERSION}`);
    const npmCli = path.join(path.dirname(nodePath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const npmRegistry = process.env.MIXLY_NPM_REGISTRY || DEFAULT_NPM_REGISTRY;
    const registries = [npmRegistry];
    if (npmRegistry === DEFAULT_NPM_REGISTRY) registries.push('https://registry.npmjs.org');
    let lastError;
    for (const [index, registry] of registries.entries()) {
      process.stdout.write(`npm registry: ${registry} (attempt ${index + 1}/${registries.length})\n`);
      try {
        await runStreaming(nodePath, [
          npmCli,
          'install',
          '--omit=dev',
          '--no-audit',
          '--no-fund',
          '--progress=false',
          '--loglevel=verbose',
          '--fetch-timeout=20000',
          '--fetch-retries=1',
          '--prefer-offline',
          '--replace-registry-host=always',
          '--registry',
          registry
        ], {
          cwd: appRoot,
          label: 'Harness npm install',
          idleTimeoutMs: 180000,
          env: { ...process.env, PATH: `${path.dirname(nodePath)};${process.env.PATH || ''}` }
        });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (index < registries.length - 1) {
          finishProgress();
          process.stdout.write(`npm registry failed; trying official registry. ${error.message}\n`);
        }
      }
    }
    if (lastError) throw lastError;
    stageProgress('Install progress', 95, 'Harness packages installed; verifying');
  } else {
    stageProgress('Install progress', 95, 'DeepSeek Harness already installed; verifying');
  }
  run(nodePath, [cliPath, '--version'], { cwd: appRoot, capture: true });
  stageProgress('Install progress', 100, `DeepSeek Harness ${DSH_VERSION} ready`);
  return cliPath;
}

function installSharedFiles(installRoot, mcpSource) {
  copyFile(path.join(__dirname, 'launcher.js'), path.join(installRoot, 'launcher.js'));
  copyFile(path.join(__dirname, 'mcp_router.js'), path.join(installRoot, 'mcp_router.js'));
  copyFile(
    path.join(__dirname, 'config', 'mixly-mcp.cordis.yml'),
    path.join(installRoot, 'config', 'mixly-mcp.cordis.yml')
  );
  copyFile(
    path.join(__dirname, 'adapter', 'mixly_harness_adapter.js'),
    path.join(installRoot, 'adapter', 'mixly_harness_adapter.js')
  );
  copyFile(
    path.join(__dirname, 'dist', 'MixlyHarness_Mixly4_Plugin.zip'),
    path.join(installRoot, 'MixlyHarness_Mixly4_Plugin.zip')
  );

  const mcpRoot = path.join(installRoot, 'mcp');
  const files = [
    'mixly_mcp_server.js',
    'mixly_code_equivalence.js',
    'validate_mixly_workspace.js',
    'package.json',
    'package-lock.json'
  ];
  for (const name of files) copyFile(path.join(mcpSource, name), path.join(mcpRoot, name));
  copyTree(path.join(mcpSource, 'node_modules'), path.join(mcpRoot, 'node_modules'));
}

function installLegacyBrowserCompat(installRoot) {
  const indexPath = path.join(
    installRoot,
    'runtime',
    'dsh-app',
    'node_modules',
    '@deepseek-ai',
    'dsh-web-frontend',
    'dist',
    'index.html'
  );
  if (!fs.existsSync(indexPath)) return false;
  const start = '<!-- mixly-legacy-browser-compat:start -->';
  const end = '<!-- mixly-legacy-browser-compat:end -->';
  const script = `${start}
    <script>
      (() => {
        if (typeof AbortSignal.timeout !== 'function') {
          AbortSignal.timeout = (milliseconds) => {
            const controller = new AbortController();
            setTimeout(() => controller.abort(), Math.max(0, Number(milliseconds) || 0));
            return controller.signal;
          };
        }
        if (typeof AbortSignal.any !== 'function') {
          AbortSignal.any = (signals) => {
            const controller = new AbortController();
            const abort = () => controller.abort();
            for (const signal of signals) {
              if (signal.aborted) {
                abort();
                break;
              }
              signal.addEventListener('abort', abort, { once: true });
            }
            return controller.signal;
          };
        }
        if (typeof Promise.withResolvers !== 'function') {
          Promise.withResolvers = () => {
            let resolve;
            let reject;
            const promise = new Promise((onResolve, onReject) => {
              resolve = onResolve;
              reject = onReject;
            });
            return { promise, resolve, reject };
          };
        }
      })();
    </script>
    ${end}`;
  let html = fs.readFileSync(indexPath, 'utf8');
  const expression = new RegExp(`${start}[\\s\\S]*?${end}`, 'g');
  if (expression.test(html)) html = html.replace(expression, script);
  else html = html.replace(/<head>/i, `<head>\n    ${script}`);
  fs.writeFileSync(indexPath, html, 'utf8');
  return true;
}

function patchBoardsHtml(mixlyHome, generation) {
  const root = path.resolve(mixlyHome);
  const appRoot = generation === 2 ? path.join(root, 'resources', 'app', 'src') : root;
  const htmlPath = path.join(appRoot, 'boards', 'index.html');
  if (!fs.existsSync(htmlPath)) throw new Error(`Mixly ${generation} boards page not found: ${htmlPath}`);
  const adapterPath = path.join(appRoot, 'mixly-harness', 'adapter.js');
  copyFile(path.join(__dirname, 'adapter', 'mixly_harness_adapter.js'), adapterPath);

  const start = '<!-- mixly-harness:start -->';
  const end = '<!-- mixly-harness:end -->';
  const encodedRoot = root
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const tag = `${start}\n    <script type="text/javascript" src="../mixly-harness/adapter.js" data-mixly-generation="${generation}" data-mixly-home="${encodedRoot}"></script>\n    ${end}`;
  let html = fs.readFileSync(htmlPath, 'utf8');
  const expression = new RegExp(`${start}[\\s\\S]*?${end}`, 'g');
  if (expression.test(html)) html = html.replace(expression, tag);
  else html = html.replace(/<\/body>/i, `    ${tag}\n</body>`);
  const backupPath = `${htmlPath}.pre-mixly-harness`;
  if (!fs.existsSync(backupPath)) fs.copyFileSync(htmlPath, backupPath);
  fs.writeFileSync(htmlPath, html, 'utf8');
  return { generation, mixlyHome: root, htmlPath, adapterPath };
}

function stageMixly4Plugin(mixlyHome) {
  const root = path.resolve(mixlyHome);
  if (!fs.existsSync(path.join(root, 'boards')) || !fs.existsSync(path.join(root, 'package.json'))) {
    throw new Error(`Mixly 4 directory is invalid: ${root}`);
  }
  const zipPath = path.join(root, 'MixlyHarness_Mixly4_Plugin.zip');
  copyFile(path.join(__dirname, 'dist', 'MixlyHarness_Mixly4_Plugin.zip'), zipPath);
  return { generation: 4, mixlyHome: root, zipPath };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const installRoot = path.resolve(
    options.installRoot || path.join(process.env.LOCALAPPDATA || process.env.USERPROFILE, 'MixlyHarness')
  );
  const mcpSource = path.resolve(options.mcpSource || path.join(__dirname, '..'));
  fs.mkdirSync(installRoot, { recursive: true });

  run(process.execPath, [path.join(__dirname, 'build_mixly4_plugin.js')]);
  installSharedFiles(installRoot, mcpSource);
  let nodePath = path.join(installRoot, 'runtime', 'node', 'node.exe');
  let dshCli = path.join(
    installRoot,
    'runtime',
    'dsh-app',
    'node_modules',
    '@deepseek-ai',
    'dsh',
    'lib',
    'bin.js'
  );
  if (!options.skipRuntime) {
    nodePath = await ensureNodeRuntime(installRoot);
    dshCli = await ensureDshRuntime(installRoot, nodePath);
  } else if (!fs.existsSync(dshCli)) {
    dshCli = null;
  }
  const legacyBrowserCompat = installLegacyBrowserCompat(installRoot);

  const legacy = [];
  for (const home of options.mixly2) legacy.push(patchBoardsHtml(home, 2));
  for (const home of options.mixly3) legacy.push(patchBoardsHtml(home, 3));
  const mixly4 = options.mixly4.map((home) => ({
    ...stageMixly4Plugin(home),
    globalAdapter: patchBoardsHtml(home, 4)
  }));
  const result = {
    installedAt: new Date().toISOString(),
    installRoot,
    nodeVersion: NODE_VERSION,
    dshVersion: DSH_VERSION,
    nodePath,
    dshCli,
    legacyBrowserCompat,
    mcpServer: path.join(installRoot, 'mcp', 'mixly_mcp_server.js'),
    mixly4Plugin: path.join(installRoot, 'MixlyHarness_Mixly4_Plugin.zip'),
    mixly4,
    legacy
  };
  fs.writeFileSync(path.join(installRoot, 'install.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  download,
  formatBytes,
  formatDuration,
  parseArgs,
  installLegacyBrowserCompat,
  patchBoardsHtml,
  stageMixly4Plugin
};
