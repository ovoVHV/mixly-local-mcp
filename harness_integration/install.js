'use strict';

const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const NODE_VERSION = '24.19.0';
const DSH_VERSION = '0.1.0-rc.6';
const NODE_ARCHIVE = `node-v${NODE_VERSION}-win-x64.zip`;
const NODE_URL = `https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}`;

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

function download(url, destination) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const output = fs.createWriteStream(destination);
    const request = https.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        output.close();
        fs.rmSync(destination, { force: true });
        download(new URL(response.headers.location, url).toString(), destination).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        output.close();
        reject(new Error(`Download failed (${response.statusCode}): ${url}`));
        return;
      }
      response.pipe(output);
      output.on('finish', () => output.close(resolve));
    });
    request.on('error', (error) => {
      output.close();
      reject(error);
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
    if (version === `v${NODE_VERSION}`) return nodePath;
    const backup = path.join(runtimeRoot, `node-backup-${Date.now()}`);
    fs.renameSync(nodeRoot, backup);
  }

  const downloads = path.join(installRoot, 'downloads');
  const archivePath = path.join(downloads, NODE_ARCHIVE);
  if (!fs.existsSync(archivePath)) {
    process.stdout.write(`Downloading Node.js v${NODE_VERSION} x64...\n`);
    await download(NODE_URL, archivePath);
  }
  const extractRoot = path.join(runtimeRoot, `node-extract-${process.pid}`);
  fs.mkdirSync(extractRoot, { recursive: true });
  run('tar.exe', ['-xf', archivePath, '-C', extractRoot]);
  const extracted = path.join(extractRoot, `node-v${NODE_VERSION}-win-x64`);
  if (!fs.existsSync(path.join(extracted, 'node.exe'))) {
    throw new Error(`Node archive did not contain the expected directory: ${extracted}`);
  }
  fs.renameSync(extracted, nodeRoot);
  fs.rmSync(extractRoot, { recursive: true, force: true });
  return nodePath;
}

function ensureDshRuntime(installRoot, nodePath) {
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

  if (!fs.existsSync(cliPath)) {
    process.stdout.write(`Installing DeepSeek Harness ${DSH_VERSION}...\n`);
    const npmCli = path.join(path.dirname(nodePath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    run(nodePath, [npmCli, 'install', '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: appRoot,
      env: { ...process.env, PATH: `${path.dirname(nodePath)};${process.env.PATH || ''}` }
    });
  }
  run(nodePath, [cliPath, '--version'], { cwd: appRoot, capture: true });
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

function patchBoardsHtml(mixlyHome, generation) {
  const root = path.resolve(mixlyHome);
  const appRoot = generation === 2 ? path.join(root, 'resources', 'app', 'src') : root;
  const htmlPath = path.join(appRoot, 'boards', 'index.html');
  if (!fs.existsSync(htmlPath)) throw new Error(`Mixly ${generation} boards page not found: ${htmlPath}`);
  const adapterPath = path.join(appRoot, 'mixly-harness', 'adapter.js');
  copyFile(path.join(__dirname, 'adapter', 'mixly_harness_adapter.js'), adapterPath);

  const start = '<!-- mixly-harness:start -->';
  const end = '<!-- mixly-harness:end -->';
  const tag = `${start}\n    <script type="text/javascript" src="../mixly-harness/adapter.js" data-mixly-generation="${generation}"></script>\n    ${end}`;
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
    dshCli = ensureDshRuntime(installRoot, nodePath);
  } else if (!fs.existsSync(dshCli)) {
    dshCli = null;
  }

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

module.exports = { parseArgs, patchBoardsHtml, stageMixly4Plugin };
