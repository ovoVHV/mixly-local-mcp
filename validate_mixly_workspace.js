'use strict';

const fs = require('fs');
const path = require('path');

function resolveWebSocket() {
  const localWsPath = path.join(__dirname, 'node_modules', 'ws');
  if (fs.existsSync(localWsPath)) {
    const localWs = require(localWsPath);
    return localWs.WebSocket || localWs;
  }
  const candidates = [];
  if (process.env.MIXLY_MCP_PLAYWRIGHT_BUNDLE) {
    candidates.push(process.env.MIXLY_MCP_PLAYWRIGHT_BUNDLE);
  }
  candidates.push(
    'C:/Users/AI/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/lib/utilsBundle.js'
  );

  const runtimesRoot = path.join(process.env.USERPROFILE || '', '.cache', 'codex-runtimes');
  if (fs.existsSync(runtimesRoot)) {
    for (const runtime of fs.readdirSync(runtimesRoot)) {
      candidates.push(path.join(
        runtimesRoot, runtime, 'dependencies', 'node', 'node_modules',
        'playwright-core', 'lib', 'utilsBundle.js'
      ));
    }
  }

  for (const candidate of candidates) {
    if (!candidate || !fs.existsSync(candidate)) continue;
    const bundle = require(candidate);
    if (bundle.ws) return bundle.ws;
  }
  throw new Error(
    'WebSocket implementation not found. Set MIXLY_MCP_PLAYWRIGHT_BUNDLE to playwright-core/lib/utilsBundle.js.'
  );
}

const WebSocket = resolveWebSocket();
const cdpPort = Number(process.env.MIXLY_CDP_PORT || 9333);

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
  const page = targets.find((target) =>
    target.type === 'page' && target.url.includes('/boards/index.html')
  ) || targets.find((target) => target.type === 'page' && target.title !== 'DevTools');
  if (!page) throw new Error('Mixly page target not found');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
  });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const commandId = ++id;
    pending.set(commandId, { resolve, reject });
    socket.send(JSON.stringify({ id: commandId, method, params }));
  });
  if (process.argv[2] === '--navigate') {
    const result = await send('Page.navigate', { url: process.argv[3] });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    socket.close();
    return;
  }

  if (process.argv[2] === '--open-project') {
    const params = new URLSearchParams({
      thirdPartyBoard: 'false',
      boardIndex: './boards/default/arduino_esp32/index.xml',
      boardType: 'Arduino ESP32',
      boardImg: './boards/default/arduino_esp32/media/esp32_compressed.png',
      language: 'C/C++',
      filePath: process.argv[3]
    });
    const url = `file:///E:/mixly2.0-win32-x64/resources/app/src/boards/index.html?${params}`;
    const result = await send('Page.navigate', { url });
    process.stdout.write(JSON.stringify({ url, ...result }, null, 2) + '\n');
    socket.close();
    return;
  }

  if (process.argv[2] === '--open-nano-project') {
    const params = new URLSearchParams({
      thirdPartyBoard: 'false',
      boardIndex: './boards/default/arduino_avr/index.xml',
      boardType: 'Arduino AVR',
      boardImg: './boards/default/arduino_avr/media/uno_compressed.png',
      language: 'C/C++',
      filePath: process.argv[3]
    });
    const url = `file:///E:/mixly2.0-win32-x64/resources/app/src/boards/index.html?${params}`;
    const result = await send('Page.navigate', { url });
    process.stdout.write(JSON.stringify({ url, ...result }, null, 2) + '\n');
    socket.close();
    return;
  }

  if (process.argv[2] === '--open-nano-blank') {
    const params = new URLSearchParams({
      thirdPartyBoard: 'false',
      boardIndex: './boards/default/arduino_avr/index.xml',
      boardType: 'Arduino AVR',
      boardImg: './boards/default/arduino_avr/media/uno_compressed.png',
      language: 'C/C++'
    });
    const url = `file:///E:/mixly2.0-win32-x64/resources/app/src/boards/index.html?${params}`;
    const result = await send('Page.navigate', { url });
    process.stdout.write(JSON.stringify({ url, ...result }, null, 2) + '\n');
    socket.close();
    return;
  }

  if (process.argv[2] === '--accept-dialog') {
    const result = await send('Page.handleJavaScriptDialog', { accept: true });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    socket.close();
    return;
  }

  if (process.argv[2] === '--test-nanoenv-import') {
    const archivePath = process.argv[3];
    const libraryName = process.argv[4] || 'NanoEnv';
    const expression = `new Promise((resolve) => {
      const path = Mixly.require('path');
      const fs = Mixly.require('fs');
      const destination = path.join(Mixly.Env.boardDirPath, 'libraries', 'ThirdParty');
      Mixly.Electron.LibManager.unZip(${JSON.stringify(archivePath)}, destination, false, (error) => {
        const libraryPath = path.join(destination, ${JSON.stringify(libraryName)});
        resolve(JSON.stringify({
          error: error ? String(error) : null,
          destination,
          libraryExists: fs.existsSync(libraryPath),
          files: fs.existsSync(libraryPath) ? fs.readdirSync(libraryPath).sort() : []
        }));
      });
    })`;
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    process.stdout.write(JSON.stringify(result.result.value, null, 2) + '\n');
    socket.close();
    return;
  }

  if (process.argv[2] === '--generate-nano-code') {
    const outputPath = process.argv[3];
    const expression = `(() => {
      const fs = Mixly.require('fs');
      const workspace = Blockly.getMainWorkspace();
      const code = Blockly.Arduino.workspaceToCode(workspace);
      fs.writeFileSync(${JSON.stringify(outputPath)}, code, 'utf8');
      return JSON.stringify({ outputPath: ${JSON.stringify(outputPath)}, length: code.length });
    })()`;
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    process.stdout.write(JSON.stringify(result.result.value, null, 2) + '\n');
    socket.close();
    return;
  }

  if (process.argv[2] === '--inspect-nano-workspace') {
    const expression = `(() => {
      const workspace = Blockly.getMainWorkspace();
      const blocks = workspace.getAllBlocks(false);
      const customBlocks = blocks.filter((block) => block.type.startsWith('nanoenv_'));
      const procedures = blocks
        .filter((block) => block.type === 'procedures_defnoreturn')
        .map((block) => block.getFieldValue('NAME'))
        .sort();
      const thirdPartyXml = Mixly.Env.thirdPartyXML || [];
      return JSON.stringify({
        ready: document.readyState,
        title: document.title,
        selectedBoard: Mixly.Boards.getSelectedBoardName(),
        editorMode: Mixly.Nav?.editorType || Mixly.Nav?.codeType || null,
        totalNodes: blocks.length,
        nativeNodes: blocks.length - customBlocks.length,
        customNodes: customBlocks.length,
        procedures,
        nanoEnvToolbox: thirdPartyXml.some((xml) => xml.includes('Nano 环境显示硬件'))
      });
    })()`;
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    process.stdout.write(JSON.stringify(result.result.value, null, 2) + '\n');
    socket.close();
    return;
  }

  const expression = process.argv[2] || `JSON.stringify({
    ready: document.readyState,
    title: document.title,
    url: location.href,
    blockly: typeof Blockly,
    mixly: typeof Mixly,
    urlHelper: typeof Url,
    boardManager: typeof BoardManager,
    mixlyKeys: typeof Mixly === 'object' ? Object.keys(Mixly).slice(0, 80) : [],
    text: (document.body && document.body.innerText || '').slice(0, 500)
  })`;
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  process.stdout.write(JSON.stringify(result.result.value, null, 2) + '\n');
  socket.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
