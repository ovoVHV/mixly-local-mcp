'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const archivePath = path.join(root, 'NanoEnv_Mixly_Library.zip');
const sourceDir = path.join(
  root,
  'resources', 'app', 'src', 'boards', 'default', 'arduino_avr',
  'libraries', 'ThirdParty', 'NanoEnv'
);
const testDir = path.resolve(root, '.nanoenv-import-test');
const compressing = require(path.join(root, 'resources', 'app', 'node_modules', 'compressing'));
const yauzl = require(path.join(
  root, 'resources', 'app', 'node_modules', 'yauzl'
));

function cleanTestDir() {
  const relative = path.relative(root, testDir);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to clean path outside workspace: ${testDir}`);
  }
  fs.rmSync(testDir, { recursive: true, force: true });
}

function listEntries(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (openError, zipFile) => {
      if (openError) return reject(openError);
      const entries = [];
      zipFile.on('entry', (entry) => {
        entries.push(entry.fileName);
        zipFile.readEntry();
      });
      zipFile.on('end', () => resolve(entries));
      zipFile.on('error', reject);
      zipFile.readEntry();
    });
  });
}

async function main() {
  const entries = await listEntries(archivePath);
  const directoryEntries = entries.filter((entry) => entry.endsWith('/'));
  if (directoryEntries.length) {
    throw new Error(`ZIP contains directory entries: ${directoryEntries.join(', ')}`);
  }

  cleanTestDir();
  fs.mkdirSync(testDir, { recursive: true });
  try {
    await compressing.zip.uncompress(archivePath, testDir, {
      zipFileNameEncoding: 'GBK'
    });
    const expectedFiles = fs.readdirSync(sourceDir).sort();
    const extractedDir = path.join(testDir, 'NanoEnv');
    const extractedFiles = fs.readdirSync(extractedDir).sort();
    if (JSON.stringify(extractedFiles) !== JSON.stringify(expectedFiles)) {
      throw new Error(`Extracted files differ: ${extractedFiles.join(', ')}`);
    }
    for (const fileName of expectedFiles) {
      const expected = fs.readFileSync(path.join(sourceDir, fileName));
      const actual = fs.readFileSync(path.join(extractedDir, fileName));
      if (!expected.equals(actual)) throw new Error(`Content differs: ${fileName}`);
    }
    console.log('Mixly compressing.zip.uncompress compatibility passed');
    console.log(`Entries: ${entries.length} files / 0 directories`);
    console.log(entries.join('\n'));
  } finally {
    cleanTestDir();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
