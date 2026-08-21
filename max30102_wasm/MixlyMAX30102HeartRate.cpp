#include "MixlyMAX30102HeartRate.h"

MixlyMAX30102HeartRate::MixlyMAX30102HeartRate()
    : ready_(false), beat_(false), ir_(0), red_(0), lastBeatMs_(0),
      bpm_(0.0f), averageBpm_(0), rateIndex_(0), rateCount_(0) {
  for (uint8_t i = 0; i < RATE_SIZE; ++i) rates_[i] = 0;
}

bool MixlyMAX30102HeartRate::begin(uint8_t address, uint32_t speed) {
  ready_ = sensor_.begin(Wire, speed, address);
  resetRate();
  return ready_;
}

void MixlyMAX30102HeartRate::configure(uint8_t powerLevel, uint8_t sampleAverage,
                                       uint16_t sampleRate, uint16_t pulseWidth,
                                       uint16_t adcRange) {
  if (!ready_) return;
  sensor_.setup(powerLevel, sampleAverage, 2, sampleRate, pulseWidth, adcRange);
  sensor_.setPulseAmplitudeGreen(0);
}

void MixlyMAX30102HeartRate::update() {
  beat_ = false;
  if (!ready_) return;
  sensor_.check();
  while (sensor_.available()) {
    const uint32_t irValue = sensor_.getFIFOIR();
    const uint32_t redValue = sensor_.getFIFORed();
    sensor_.nextSample();
    processSample(irValue, redValue);
  }
}

void MixlyMAX30102HeartRate::processSample(uint32_t irValue, uint32_t redValue) {
  ir_ = irValue;
  red_ = redValue;
  if (!checkForBeat((int32_t)irValue)) return;

  beat_ = true;
  const uint32_t now = millis();
  if (lastBeatMs_ != 0) {
    const uint32_t delta = now - lastBeatMs_;
    if (delta > 0) {
      const float nextBpm = 60000.0f / (float)delta;
      if (nextBpm > 20.0f && nextBpm < 255.0f) {
        bpm_ = nextBpm;
        rates_[rateIndex_] = (uint8_t)(nextBpm + 0.5f);
        rateIndex_ = (rateIndex_ + 1) % RATE_SIZE;
        if (rateCount_ < RATE_SIZE) ++rateCount_;
        uint16_t total = 0;
        for (uint8_t i = 0; i < rateCount_; ++i) total += rates_[i];
        averageBpm_ = rateCount_ ? total / rateCount_ : 0;
      }
    }
  }
  lastBeatMs_ = now;
}

void MixlyMAX30102HeartRate::resetRate() {
  beat_ = false;
  ir_ = 0;
  red_ = 0;
  lastBeatMs_ = 0;
  bpm_ = 0.0f;
  averageBpm_ = 0;
  rateIndex_ = 0;
  rateCount_ = 0;
  for (uint8_t i = 0; i < RATE_SIZE; ++i) rates_[i] = 0;
}

bool MixlyMAX30102HeartRate::ready() const { return ready_; }
uint32_t MixlyMAX30102HeartRate::ir() const { return ir_; }
uint32_t MixlyMAX30102HeartRate::red() const { return red_; }
bool MixlyMAX30102HeartRate::beatDetected() const { return beat_; }
float MixlyMAX30102HeartRate::bpm() const { return bpm_; }
uint16_t MixlyMAX30102HeartRate::averageBpm() const { return averageBpm_; }

bool MixlyMAX30102HeartRate::fingerPresent(uint32_t threshold) const {
  return ir_ >= threshold;
}

void MixlyMAX30102HeartRate::setRedLed(uint8_t amplitude) {
  if (ready_) sensor_.setPulseAmplitudeRed(amplitude);
}

void MixlyMAX30102HeartRate::setIrLed(uint8_t amplitude) {
  if (ready_) sensor_.setPulseAmplitudeIR(amplitude);
}

float MixlyMAX30102HeartRate::temperatureC() {
  return ready_ ? sensor_.readTemperature() : NAN;
}
