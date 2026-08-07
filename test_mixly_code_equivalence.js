'use strict';

const assert = require('assert');
const { compareCode } = require('./mixly_code_equivalence');

const original = `
#define LED_PIN 2
const int PRICE = 300;
void registerCard() {
  if (isUidRegistered(uid)) {
    display("Already Registered");
    return;
  }
  digitalWrite(LED_PIN, HIGH);
  delay(50);
}
`;

const incomplete = `
#define LED_PIN 2
const int PRICE = 300;
void registerCard() {
  digitalWrite(LED_PIN, HIGH);
  delay(50);
}
`;

const failed = compareCode({
  mode: 'behavioral-strict',
  sourceFiles: [{ name: 'original.ino', text: original }],
  generatedFiles: [{ name: 'generated.ino', text: incomplete }]
});

assert.equal(failed.passed, false);
assert(failed.gaps.missingGuardCalls.includes('isUidRegistered'));
assert(failed.gaps.missingStrings.includes('Already Registered'));

const complete = compareCode({
  mode: 'behavioral-strict',
  sourceFiles: [{ name: 'original.ino', text: original }],
  generatedFiles: [{ name: 'generated.ino', text: original }],
  requiredPatterns: [{ label: 'duplicate-card guard', pattern: 'isUidRegistered\\s*\\(' }]
});

assert.equal(complete.passed, true);
assert.equal(complete.behavioralGapCount, 0);
assert.equal(complete.requiredPatterns[0].matched, true);

const exact = compareCode({
  mode: 'exact',
  sourceFiles: [{ name: 'left.ino', text: 'int x = 1; // comment\n' }],
  generatedFiles: [{ name: 'right.ino', text: 'int   x=1;' }]
});

assert.equal(exact.passed, true);
const exactStringDifference = compareCode({
  mode: 'exact',
  sourceFiles: [{ name: 'left.ino', text: 'const char* s = "A B";' }],
  generatedFiles: [{ name: 'right.ino', text: 'const char* s = "AB";' }]
});
assert.equal(exactStringDifference.passed, false);

const pythonSource = `
PRICE = 300  # cents
def register_card():
    if is_uid_registered(uid):
        display("Already Registered")
        return
`;
const pythonIncomplete = `
PRICE = 300
def register_card():
    return
`;
const pythonAudit = compareCode({
  mode: 'behavioral-strict',
  sourceFiles: [{ name: 'original.py', text: pythonSource }],
  generatedFiles: [{ name: 'generated.py', text: pythonIncomplete }]
});
assert.equal(pythonAudit.passed, false);
assert(pythonAudit.gaps.missingGuardCalls.includes('is_uid_registered'));
assert(pythonAudit.gaps.missingStrings.includes('Already Registered'));
assert.equal(pythonAudit.gaps.missingConstants.length, 0);

const pythonExact = compareCode({
  mode: 'exact',
  sourceFiles: [{ name: 'left.py', text: 'VALUE = 1  # comment\n' }],
  generatedFiles: [{ name: 'right.py', text: 'VALUE=1\n' }]
});
assert.equal(pythonExact.passed, true);
console.log('Mixly code equivalence audit passed');
