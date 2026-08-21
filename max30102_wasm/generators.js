'use strict';

function max30102Generator(generator) {
  const target = generator || Blockly.Arduino;
  target.definitions_ = target.definitions_ || {};
  target.setups_ = target.setups_ || {};
  target.definitions_.define_max30102_wasm_single_translation_unit = '#define MIXLY_WASM_SINGLE_TRANSLATION_UNIT 1';
  target.definitions_.include_wire = '#include <Wire.h>';
  target.definitions_.include_max30102_wasm = '#include "MixlyMAX30102HeartRate.h"';
  target.definitions_.var_max30102_wasm = 'MixlyMAX30102HeartRate mixlyMax30102;';
  return target;
}

Blockly.Arduino.forBlock['max30102_wasm_begin'] = function(block, generator) {
  const target = max30102Generator(generator);
  const address = target.valueToCode(block, 'ADDRESS', target.ORDER_NONE) || '0x57';
  const speed = block.getFieldValue('SPEED') || 'I2C_SPEED_FAST';
  return `mixlyMax30102.begin((uint8_t)(${address}), ${speed});\n`;
};

Blockly.Arduino.forBlock['max30102_wasm_configure'] = function(block, generator) {
  const target = max30102Generator(generator);
  const power = target.valueToCode(block, 'POWER', target.ORDER_NONE) || '31';
  const average = block.getFieldValue('AVERAGE') || '4';
  const rate = block.getFieldValue('RATE') || '100';
  const width = block.getFieldValue('WIDTH') || '411';
  const range = block.getFieldValue('RANGE') || '4096';
  return `mixlyMax30102.configure((uint8_t)(${power}), ${average}, ${rate}, ${width}, ${range});\n`;
};

Blockly.Arduino.forBlock['max30102_wasm_update'] = function(block, generator) {
  max30102Generator(generator);
  return 'mixlyMax30102.update();\n';
};

Blockly.Arduino.forBlock['max30102_wasm_ready'] = function(block, generator) {
  const target = max30102Generator(generator);
  return ['mixlyMax30102.ready()', target.ORDER_ATOMIC];
};

Blockly.Arduino.forBlock['max30102_wasm_ir'] = function(block, generator) {
  const target = max30102Generator(generator);
  return ['mixlyMax30102.ir()', target.ORDER_ATOMIC];
};

Blockly.Arduino.forBlock['max30102_wasm_red'] = function(block, generator) {
  const target = max30102Generator(generator);
  return ['mixlyMax30102.red()', target.ORDER_ATOMIC];
};

Blockly.Arduino.forBlock['max30102_wasm_beat'] = function(block, generator) {
  const target = max30102Generator(generator);
  return ['mixlyMax30102.beatDetected()', target.ORDER_ATOMIC];
};

Blockly.Arduino.forBlock['max30102_wasm_bpm'] = function(block, generator) {
  const target = max30102Generator(generator);
  return ['mixlyMax30102.bpm()', target.ORDER_ATOMIC];
};

Blockly.Arduino.forBlock['max30102_wasm_average_bpm'] = function(block, generator) {
  const target = max30102Generator(generator);
  return ['mixlyMax30102.averageBpm()', target.ORDER_ATOMIC];
};

Blockly.Arduino.forBlock['max30102_wasm_finger'] = function(block, generator) {
  const target = max30102Generator(generator);
  const threshold = target.valueToCode(block, 'THRESHOLD', target.ORDER_NONE) || '50000';
  return [`mixlyMax30102.fingerPresent((uint32_t)(${threshold}))`, target.ORDER_ATOMIC];
};

Blockly.Arduino.forBlock['max30102_wasm_led'] = function(block, generator) {
  const target = max30102Generator(generator);
  const amplitude = target.valueToCode(block, 'AMPLITUDE', target.ORDER_NONE) || '10';
  const method = block.getFieldValue('LED') === 'IR' ? 'setIrLed' : 'setRedLed';
  return `mixlyMax30102.${method}((uint8_t)(${amplitude}));\n`;
};

Blockly.Arduino.forBlock['max30102_wasm_temperature'] = function(block, generator) {
  const target = max30102Generator(generator);
  return ['mixlyMax30102.temperatureC()', target.ORDER_ATOMIC];
};

Blockly.Arduino.forBlock['max30102_wasm_reset_rate'] = function(block, generator) {
  max30102Generator(generator);
  return 'mixlyMax30102.resetRate();\n';
};
