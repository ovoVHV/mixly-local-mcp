'use strict';

const fs = require('fs');
const path = require('path');

const root = __dirname;
const upstream = path.join(root, 'upstream');
const read = (filePath) => fs.readFileSync(filePath, 'utf8');
const toolboxXml = read(path.join(root, 'toolbox.xml'));
const blockTypes = [...toolboxXml.matchAll(/<block\s+type="([^"]+)/g)].map((match) => match[1]);
const wasmSketchFiles = ['MAX30105.h', 'MAX30105.cpp', 'heartRate.h', 'heartRate.cpp']
  .map((name) => ({ name, text: read(path.join(upstream, name)) }));

for (const name of ['MixlyMAX30102HeartRate.h', 'MixlyMAX30102HeartRate.cpp']) {
  wasmSketchFiles.push({ name, text: read(path.join(root, name)) });
}

const args = {
  libraryName: 'MAX30102_WASM_HeartRate',
  board: 'default/arduino_avr',
  version: '1.0.1',
  overwrite: true,
  blocksJs: read(path.join(root, 'blocks.js')),
  generatorsJs: read(path.join(root, 'generators.js')),
  toolboxXml,
  wasmSketchFiles,
  primitiveReasons: blockTypes.map((type) => ({
    type,
    reason: 'Mixly 4 AVR WASM manifest has no MAX30102/MAX30105 driver, so this hardware primitive is provided locally.',
    officialCandidatesChecked: [
      'sensor blocks',
      'I2C/Wire blocks',
      'mixly_scan_arduino_libraries MAX30102.h MAX30105.h heartRate.h'
    ]
  })),
  extraFiles: [
    { relativePath: 'README.md', text: read(path.join(root, 'README.md')) },
    {
      relativePath: 'libraries/MAX30102_WASM/library.properties',
      text: [
        'name=MAX30102 WASM Heart Rate',
        'version=1.0.1',
        'author=Mixly Local MCP; SparkFun Electronics',
        'maintainer=Mixly Local MCP',
        'sentence=MAX30102 heart-rate driver for Mixly 4 browser WASM compilation.',
        'paragraph=Wraps the SparkFun MAX3010x driver and Maxim beat detector for Arduino AVR.',
        'category=Sensors',
        'architectures=avr',
        'includes=MixlyMAX30102HeartRate.h',
        ''
      ].join('\n')
    },
    { relativePath: 'libraries/MAX30102_WASM/LICENSE.md', text: read(path.join(upstream, 'LICENSE.md')) },
    ...wasmSketchFiles.map((item) => ({
      relativePath: `libraries/MAX30102_WASM/src/${item.name}`,
      text: item.text
    }))
  ]
};

const outputPath = path.join(root, 'create_args.json');
fs.writeFileSync(outputPath, `${JSON.stringify(args, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  outputPath,
  blockTypes: blockTypes.length,
  wasmSketchFiles: wasmSketchFiles.map((item) => ({
    name: item.name,
    bytes: Buffer.byteLength(item.text)
  })),
  bytes: fs.statSync(outputPath).size
}, null, 2));
