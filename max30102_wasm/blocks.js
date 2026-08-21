'use strict';

const MAX30102_HUE = 40;

Blockly.Blocks['max30102_wasm_begin'] = {
  init: function() {
    this.setColour(MAX30102_HUE);
    this.appendValueInput('ADDRESS')
      .setCheck(Number)
      .appendField('MAX30102 初始化 地址');
    this.appendDummyInput()
      .appendField('I2C')
      .appendField(new Blockly.FieldDropdown([
        ['400kHz', 'I2C_SPEED_FAST'],
        ['100kHz', 'I2C_SPEED_STANDARD']
      ]), 'SPEED');
    this.setPreviousStatement(true);
    this.setNextStatement(true);
  }
};

Blockly.Blocks['max30102_wasm_configure'] = {
  init: function() {
    this.setColour(MAX30102_HUE);
    this.appendValueInput('POWER')
      .setCheck(Number)
      .appendField('MAX30102 配置 LED电流');
    this.appendDummyInput()
      .appendField('平均')
      .appendField(new Blockly.FieldDropdown([
        ['1', '1'], ['2', '2'], ['4', '4'], ['8', '8'], ['16', '16'], ['32', '32']
      ]), 'AVERAGE')
      .appendField('采样率')
      .appendField(new Blockly.FieldDropdown([
        ['50', '50'], ['100', '100'], ['200', '200'], ['400', '400'],
        ['800', '800'], ['1000', '1000'], ['1600', '1600'], ['3200', '3200']
      ]), 'RATE');
    this.appendDummyInput()
      .appendField('脉宽')
      .appendField(new Blockly.FieldDropdown([
        ['69us', '69'], ['118us', '118'], ['215us', '215'], ['411us', '411']
      ]), 'WIDTH')
      .appendField('量程')
      .appendField(new Blockly.FieldDropdown([
        ['2048', '2048'], ['4096', '4096'], ['8192', '8192'], ['16384', '16384']
      ]), 'RANGE');
    this.setPreviousStatement(true);
    this.setNextStatement(true);
  }
};

Blockly.Blocks['max30102_wasm_update'] = {
  init: function() {
    this.setColour(MAX30102_HUE);
    this.appendDummyInput().appendField('MAX30102 更新心率采样');
    this.setPreviousStatement(true);
    this.setNextStatement(true);
  }
};

Blockly.Blocks['max30102_wasm_ready'] = {
  init: function() {
    this.setColour(MAX30102_HUE);
    this.appendDummyInput().appendField('MAX30102 已连接');
    this.setOutput(true, Boolean);
  }
};

Blockly.Blocks['max30102_wasm_ir'] = {
  init: function() {
    this.setColour(MAX30102_HUE);
    this.appendDummyInput().appendField('MAX30102 红外值');
    this.setOutput(true, Number);
  }
};

Blockly.Blocks['max30102_wasm_red'] = {
  init: function() {
    this.setColour(MAX30102_HUE);
    this.appendDummyInput().appendField('MAX30102 红光值');
    this.setOutput(true, Number);
  }
};

Blockly.Blocks['max30102_wasm_beat'] = {
  init: function() {
    this.setColour(MAX30102_HUE);
    this.appendDummyInput().appendField('MAX30102 检测到心跳');
    this.setOutput(true, Boolean);
  }
};

Blockly.Blocks['max30102_wasm_bpm'] = {
  init: function() {
    this.setColour(MAX30102_HUE);
    this.appendDummyInput().appendField('MAX30102 当前 BPM');
    this.setOutput(true, Number);
  }
};

Blockly.Blocks['max30102_wasm_average_bpm'] = {
  init: function() {
    this.setColour(MAX30102_HUE);
    this.appendDummyInput().appendField('MAX30102 平均 BPM');
    this.setOutput(true, Number);
  }
};

Blockly.Blocks['max30102_wasm_finger'] = {
  init: function() {
    this.setColour(MAX30102_HUE);
    this.appendValueInput('THRESHOLD')
      .setCheck(Number)
      .appendField('MAX30102 有手指 阈值');
    this.setOutput(true, Boolean);
  }
};

Blockly.Blocks['max30102_wasm_led'] = {
  init: function() {
    this.setColour(MAX30102_HUE);
    this.appendValueInput('AMPLITUDE')
      .setCheck(Number)
      .appendField('MAX30102')
      .appendField(new Blockly.FieldDropdown([
        ['红光 LED', 'RED'],
        ['红外 LED', 'IR']
      ]), 'LED')
      .appendField('电流');
    this.setPreviousStatement(true);
    this.setNextStatement(true);
  }
};

Blockly.Blocks['max30102_wasm_temperature'] = {
  init: function() {
    this.setColour(MAX30102_HUE);
    this.appendDummyInput().appendField('MAX30102 芯片温度 °C');
    this.setOutput(true, Number);
  }
};

Blockly.Blocks['max30102_wasm_reset_rate'] = {
  init: function() {
    this.setColour(MAX30102_HUE);
    this.appendDummyInput().appendField('MAX30102 清空心率平均值');
    this.setPreviousStatement(true);
    this.setNextStatement(true);
  }
};
