'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const archivePath = path.join(root, 'LiftLight_Mixly_Library.zip');
const sourceDir = path.join(
  root,
  'resources', 'app', 'src', 'boards', 'default', 'arduino_avr',
  'libraries', 'ThirdParty', 'LiftLight'
);
const testDir = path.resolve(root, '.liftlight-import-test');
const compressing = require(path.join(root, 'resources', 'app', 'node_modules', 'compressing'));
const yauzl = require(path.join(root, 'resources', 'app', 'node_modules', 'yauzl'));

function clean() {
  const relative = path.relative(root, testDir);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to clean path outside workspace: ${testDir}`);
  }
  fs.rmSync(testDir, { recursive: true, force: true });
}

function entries(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (error, zipFile) => {
      if (error) return reject(error);
      const result = [];
      zipFile.on('entry', (entry) => { result.push(entry.fileName); zipFile.readEntry(); });
      zipFile.on('end', () => resolve(result));
      zipFile.on('error', reject);
      zipFile.readEntry();
    });
  });
}

async function main() {
  const names = await entries(archivePath);
  const dirs = names.filter((name) => name.endsWith('/'));
  if (dirs.length) throw new Error(`ZIP contains directory entries: ${dirs.join(', ')}`);
  clean();
  fs.mkdirSync(testDir, { recursive: true });
  try {
    await compressing.zip.uncompress(archivePath, testDir, { zipFileNameEncoding: 'GBK' });
    const expected = fs.readdirSync(sourceDir).sort();
    const actualDir = path.join(testDir, 'LiftLight');
    const actual = fs.readdirSync(actualDir).sort();
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      throw new Error(`Extracted file list differs: ${actual.join(', ')}`);
    }
    for (const name of expected) {
      if (!fs.readFileSync(path.join(sourceDir, name)).equals(
        fs.readFileSync(path.join(actualDir, name)))) {
        throw new Error(`Extracted content differs: ${name}`);
      }
    }
    console.log('LiftLight Mixly unzip compatibility passed');
    console.log(`Entries: ${names.length} files / 0 directories`);
    console.log(names.join('\n'));
  } finally {
    clean();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

