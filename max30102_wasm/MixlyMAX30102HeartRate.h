/*
 * Mixly 4 MAX30102 state wrapper.
 * The bundled SparkFun driver and Maxim PBA beat detector retain their
 * original license notices in MAX30105.* and heartRate.*.
 */
#pragma once

#include <Arduino.h>
#include <Wire.h>
#include "MAX30105.h"
#include "heartRate.h"

class MixlyMAX30102HeartRate {
 public:
  MixlyMAX30102HeartRate();

  bool begin(uint8_t address = MAX30105_ADDRESS, uint32_t speed = I2C_SPEED_FAST);
  void configure(uint8_t powerLevel = 31, uint8_t sampleAverage = 4,
                 uint16_t sampleRate = 100, uint16_t pulseWidth = 411,
                 uint16_t adcRange = 4096);
  void update();
  void resetRate();

  bool ready() const;
  uint32_t ir() const;
  uint32_t red() const;
  bool beatDetected() const;
  float bpm() const;
  uint16_t averageBpm() const;
  bool fingerPresent(uint32_t threshold = 50000UL) const;
  void setRedLed(uint8_t amplitude);
  void setIrLed(uint8_t amplitude);
  float temperatureC();

 private:
  static const uint8_t RATE_SIZE = 4;
  MAX30105 sensor_;
  bool ready_;
  bool beat_;
  uint32_t ir_;
  uint32_t red_;
  uint32_t lastBeatMs_;
  float bpm_;
  uint16_t averageBpm_;
  uint8_t rates_[RATE_SIZE];
  uint8_t rateIndex_;
  uint8_t rateCount_;

  void processSample(uint32_t irValue, uint32_t redValue);
};

// Mixly 4 AVR's browser compiler mounts sketch .cpp files but only compiles
// the main sketch translation unit. The macro is emitted only by this plugin;
// a normal Arduino library build continues compiling the .cpp files normally.
#ifdef MIXLY_WASM_SINGLE_TRANSLATION_UNIT
#include "MAX30105.cpp"
#include "heartRate.cpp"
#include "MixlyMAX30102HeartRate.cpp"
#endif
