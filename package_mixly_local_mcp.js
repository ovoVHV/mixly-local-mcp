'use strict';

const fs = require('fs');
const path = require('path');

const toolsDir = __dirname;
const root = path.resolve(toolsDir, '..');
const packageMetadata = require(path.join(toolsDir, 'package.json'));
const outputPath = path.join(root, `Mixly_Local_MCP_v${packageMetadata.version}.zip`);
const packageRoot = 'MixlyLocalMCP';
const yazl = require(path.join(toolsDir, 'node_modules', 'yazl'));

const sources = [
  { source: path.join(toolsDir, 'mixly_mcp_server.js'), archive: 'mixly_mcp_server.js' },
  { source: path.join(toolsDir, 'mixly_code_equivalence.js'), archive: 'mixly_code_equivalence.js' },
  { source: path.join(toolsDir, 'test_mixly_code_equivalence.js'), archive: 'test_mixly_code_equivalence.js' },
  { source: path.join(toolsDir, 'validate_mixly_workspace.js'), archive: 'validate_mixly_workspace.js' },
  { source: path.join(toolsDir, 'mixly_mcp_call.js'), archive: 'mixly_mcp_call.js' },
  { source: path.join(toolsDir, 'Mixly4_MCP_Server.cmd'), archive: 'Mixly4_MCP_Server.cmd' },
  { source: path.join(toolsDir, 'Install_Mixly_AI.cmd'), archive: 'Install_Mixly_AI.cmd' },
  { source: path.join(toolsDir, 'Install_Mixly4_AI.cmd'), archive: 'Install_Mixly4_AI.cmd' },
  { source: path.join(toolsDir, 'package.json'), archive: 'package.json' },
  { source: path.join(toolsDir, 'package-lock.json'), archive: 'package-lock.json' },
  { source: path.join(toolsDir, 'README.md'), archive: 'README.md' }
];

function filesRecursive(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...filesRecursive(full));
    else result.push(full);
  }
  return result;
}

for (const filePath of filesRecursive(path.join(toolsDir, 'node_modules'))) {
  sources.push({
    source: filePath,
    archive: path.relative(toolsDir, filePath).replace(/\\/g, '/')
  });
}

const harnessRoot = path.join(toolsDir, 'harness_integration');
for (const filePath of filesRecursive(harnessRoot)) {
  if (filePath.toLowerCase().endsWith('.png')) continue;
  sources.push({
    source: filePath,
    archive: `harness_integration/${path.relative(harnessRoot, filePath).replace(/\\/g, '/')}`
  });
}

for (const item of sources) {
  if (!fs.existsSync(item.source) || !fs.statSync(item.source).isFile()) {
    throw new Error(`Missing package file: ${item.source}`);
  }
}

const temporaryPath = `${outputPath}.tmp-${process.pid}`;
const zip = new yazl.ZipFile();
const output = fs.createWriteStream(temporaryPath);
zip.outputStream.pipe(output);
for (const item of sources) {
  zip.addFile(item.source, `${packageRoot}/${item.archive}`);
}
output.on('close', () => {
  if (fs.existsSync(outputPath)) fs.rmSync(outputPath, { force: true });
  fs.renameSync(temporaryPath, outputPath);
  console.log(`Created ${outputPath}`);
  console.log(`Entries: ${sources.length} files / 0 directories`);
});
output.on('error', (error) => { throw error; });
zip.end();
