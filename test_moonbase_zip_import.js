'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const compressing = require(path.resolve(__dirname, '..', 'resources', 'app', 'node_modules', 'compressing'));

async function main() {
  const root = path.resolve(__dirname, '..');
  const zip = path.join(root, 'MoonBase_Mixly_Library.zip');
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'mixly-moonbase-import-'));
  try {
    // Reproduce the user's case: a previous failed import already created this directory.
    fs.mkdirSync(path.join(destination, 'MoonBase', 'libraries'), { recursive: true });
    await compressing.zip.uncompress(zip, destination, { zipFileNameEncoding: 'GBK' });

    const required = ['blocks.js', 'generators.js', 'moonbase.xml'];
    for (const file of required) {
      const imported = path.join(destination, 'MoonBase', file);
      if (!fs.statSync(imported).isFile()) throw new Error(`Missing imported file: ${imported}`);
    }
    process.stdout.write('Mixly unzip compatibility OK\n');
  } finally {
    fs.rmSync(destination, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
