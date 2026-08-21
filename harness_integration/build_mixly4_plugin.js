'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yazl = require('../node_modules/yazl');

const root = __dirname;
const pluginRoot = path.join(root, 'mixly4_plugin');
const outputPath = path.join(root, 'dist', 'MixlyHarness_Mixly4_Plugin.zip');
fs.mkdirSync(path.dirname(outputPath), { recursive: true });

const zip = new yazl.ZipFile();
const output = fs.createWriteStream(outputPath);
zip.outputStream.pipe(output);
for (const name of ['plugin.json', 'index.xml', 'index.js']) {
  zip.addFile(path.join(pluginRoot, name), name);
}
output.on('close', () => process.stdout.write(`${outputPath}\n`));
output.on('error', (error) => { throw error; });
zip.end();
