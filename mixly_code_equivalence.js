'use strict';

const CONTROL_WORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'sizeof', 'typeof', 'return',
  'new', 'delete', 'static_cast', 'reinterpret_cast', 'const_cast',
  'dynamic_cast', 'F'
]);

const SIDE_EFFECT_PATTERN = /(?:^|\.|->|::)(?:begin|end|init|print|println|printf|write|put|update|remove|clear|display|send|play|stop|restart|commit|flush|setups?|delay|delayMicroseconds|pinMode|digitalWrite|analogWrite|tone|noTone)$/i;

// These calls carry hardware/timing arguments whose values are part of the
// behavior.  Keep this list deliberately small and conservative: broad call
// matching would make a refactored implementation look different even when it
// preserves the observable behavior.
const CRITICAL_CALL_PATTERN = /(?:^|\.|->|::)(?:delay|delayMicroseconds|pinMode|digitalWrite|digitalRead|analogWrite|analogRead|tone|noTone|sleep|sleep_ms|sleep_us|sleep_ns)$/i;

const MULTI_CHAR_OPERATORS = [
  '>>=', '<<=', '->*', '...', '==', '!=', '<=', '>=', '&&', '||',
  '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>',
  '->', '::', '.*'
];

function unique(values) {
  return [...new Set(values)];
}

function stripComments(source) {
  const text = String(source || '');
  let result = '';
  let quote = null;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const current = text[index];
    const next = text[index + 1];
    if (quote) {
      result += current;
      if (escaped) escaped = false;
      else if (current === '\\') escaped = true;
      else if (current === quote) quote = null;
      continue;
    }
    if (current === '"' || current === "'") {
      quote = current;
      result += current;
      continue;
    }
    if (current === '/' && next === '/') {
      result += '  ';
      index += 2;
      while (index < text.length && text[index] !== '\n') {
        result += ' ';
        index++;
      }
      if (index < text.length) result += '\n';
      continue;
    }
    if (current === '/' && next === '*') {
      result += '  ';
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) {
        result += text[index] === '\n' ? '\n' : ' ';
        index++;
      }
      if (index < text.length) {
        result += '  ';
        index++;
      }
      continue;
    }
    if (current === '#') {
      const lineStart = text.lastIndexOf('\n', index - 1) + 1;
      const before = text.slice(lineStart, index);
      const directive = text.slice(index + 1).match(/^\s*([A-Za-z_][\w]*)/);
      const preprocessor = /^\s*$/.test(before) && directive &&
        /^(?:define|elif|else|endif|error|if|ifdef|ifndef|include|line|pragma|undef)$/.test(directive[1]);
      if (!preprocessor) {
        result += ' ';
        index++;
        while (index < text.length && text[index] !== '\n') {
          result += ' ';
          index++;
        }
        if (index < text.length) result += '\n';
        continue;
      }
    }
    result += current;
  }
  return result;
}

function isIdentifierStartChar(value) {
  if (!value) return false;
  return /[A-Za-z_$]/.test(value) || value.charCodeAt(0) > 0x7f;
}

function isIdentifierPartChar(value) {
  if (!value) return false;
  return /[A-Za-z0-9_$]/.test(value) || value.charCodeAt(0) > 0x7f;
}

function isIdentifierToken(value) {
  const text = String(value || '');
  if (!text || !isIdentifierStartChar(text[0])) return false;
  for (let index = 1; index < text.length; index++) {
    if (!isIdentifierPartChar(text[index])) return false;
  }
  return true;
}

// A small language-neutral lexer is enough for the comparison tasks here and
// preserves token boundaries that normalizedExact previously discarded.
function lexTokens(source) {
  const text = stripComments(String(source || ''));
  const tokens = [];
  let index = 0;
  while (index < text.length) {
    const current = text[index];
    if (/\s/.test(current)) {
      index++;
      continue;
    }
    if (current === '"' || current === "'") {
      const start = index++;
      let escaped = false;
      while (index < text.length) {
        const value = text[index++];
        if (escaped) {
          escaped = false;
        } else if (value === '\\') {
          escaped = true;
        } else if (value === current) {
          break;
        }
      }
      tokens.push(text.slice(start, index));
      continue;
    }
    if (isIdentifierStartChar(current)) {
      const start = index++;
      while (index < text.length && isIdentifierPartChar(text[index])) index++;
      tokens.push(text.slice(start, index));
      continue;
    }
    const numeric = text.slice(index).match(/^(?:0[xX][0-9A-Fa-f]+|0[bB][01]+|0[oO][0-7]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)(?:[uUlLfFzZ]+)?/);
    if (numeric) {
      tokens.push(numeric[0]);
      index += numeric[0].length;
      continue;
    }
    const operator = MULTI_CHAR_OPERATORS.find((candidate) => text.startsWith(candidate, index));
    if (operator) {
      tokens.push(operator);
      index += operator.length;
      continue;
    }
    tokens.push(current);
    index++;
  }
  return tokens;
}

function canonicalNumericToken(value) {
  const token = String(value || '');
  const suffixMatch = token.match(/([uUlLfFzZ]+)$/);
  const suffix = suffixMatch ? suffixMatch[1] : '';
  const body = suffix ? token.slice(0, -suffix.length) : token;
  try {
    if (/^0[xX][0-9A-Fa-f]+$/.test(body)) return BigInt(body).toString();
    if (/^0[bB][01]+$/.test(body)) return BigInt(body).toString();
    if (/^0[oO][0-7]+$/.test(body)) return BigInt(`0o${body.slice(2)}`).toString();
    if (/^\d+[uUlL]+$/.test(token)) return body.replace(/^0+(?=\d)/, '');
  } catch (_error) {
    return token;
  }
  return token;
}

function normalizedTokenSequence(source, constants, ignoredIdentifiers, expandConstants = false) {
  let tokens = lexTokens(source);
  const constantMap = constants instanceof Map
    ? constants
    : new Map(Object.entries(constants || {}));
  const ignored = ignoredIdentifiers instanceof Set
    ? ignoredIdentifiers
    : new Set(ignoredIdentifiers || []);
  if (expandConstants) {
    // Resolve simple aliases (including chains) without attempting to evaluate
    // arbitrary C/C++ expressions or function-like macros.
    for (let pass = 0; pass < 8; pass++) {
      let changed = false;
      const expanded = [];
      for (const token of tokens) {
        if (isIdentifierToken(token) && ignored.has(token)) {
          expanded.push('__mixly_ignored_identifier__');
        } else if (isIdentifierToken(token) && constantMap.has(token)) {
          expanded.push(...lexTokens(constantMap.get(token)));
          changed = true;
        } else {
          expanded.push(token);
        }
      }
      tokens = expanded;
      if (!changed) break;
    }
  } else {
    tokens = tokens.map((token) => isIdentifierToken(token) && ignored.has(token)
      ? '__mixly_ignored_identifier__' : token);
  }
  return tokens.map(canonicalNumericToken).join('\u001f');
}

function stringLiterals(source) {
  const values = [];
  const pattern = /(?:u8|u|U|L)?"((?:\\.|[^"\\])*)"|(?:u8|u|U|L)?'((?:\\.|[^'\\])*)'/g;
  // Header names in #include directives are dependencies, not user-visible
  // behavior.  Exclude them before collecting strings to avoid false gaps.
  const withoutIncludes = String(source || '').replace(
    /^\s*#\s*include\s*(?:<[^>\r\n]+>|"[^"\r\n]+")\s*[^\r\n]*$/gm,
    ''
  );
  for (const match of withoutIncludes.matchAll(pattern)) {
    let value = match[1] != null ? match[1] : match[2];
    value = value
      .replace(/\\r/g, '\r')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\([\\"'])/g, '$1')
      .trim();
    if (value.length >= 3 && !/^[%\s,.:;_\-+*/\\]+$/.test(value)) values.push(value);
  }
  return unique(values);
}

function maskStrings(source) {
  const text = String(source || '');
  let result = '';
  let quote = null;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const current = text[index];
    if (quote) {
      result += current === '\n' ? '\n' : ' ';
      if (escaped) escaped = false;
      else if (current === '\\') escaped = true;
      else if (current === quote) quote = null;
      continue;
    }
    if (current === '"' || current === "'") {
      quote = current;
      result += ' ';
    } else {
      result += current;
    }
  }
  return result;
}

function matchingParen(masked, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < masked.length; index++) {
    if (masked[index] === '(') depth++;
    else if (masked[index] === ')' && --depth === 0) return index;
  }
  return -1;
}

function functionHeaderName(prefix, candidate) {
  // `prefix` stops immediately before the identifier matched as the callee;
  // validate the return-type/declaration prefix and return that candidate.
  const text = String(prefix);
  const boundary = Math.max(
    text.lastIndexOf(';'), text.lastIndexOf('{'), text.lastIndexOf('}'),
    text.lastIndexOf('\n'), text.lastIndexOf('\r')
  );
  const declarationPrefix = text.slice(boundary + 1);
  const header = /^\s*(?:template\s*<[^>]+>\s*)?(?:(?:static|inline|virtual|constexpr|const|volatile|unsigned|signed|long|short|friend|explicit)\s+)*(?:[A-Za-z_$][\w$]*(?:::[A-Za-z_$][\w$]*)?)(?:\s*[*&]+)?\s*$/;
  return candidate && header.test(declarationPrefix) ? candidate : null;
}

function callRecords(source) {
  const clean = stripComments(source);
  const masked = maskStrings(clean);
  const pattern = /\b([A-Za-z_$][\w$]*(?:(?:\.|->|::)[A-Za-z_$][\w$]*)*)\s*\(/g;
  const records = [];
  let match;
  while ((match = pattern.exec(masked))) {
    const callee = match[1];
    const shortName = callee.split(/\.|->|::/).pop();
    if (CONTROL_WORDS.has(shortName)) continue;
    const openIndex = masked.indexOf('(', match.index + callee.length);
    const closeIndex = matchingParen(masked, openIndex);
    if (closeIndex < 0) continue;
    const prefix = masked.slice(Math.max(0, match.index - 160), match.index);
    const next = masked.slice(closeIndex + 1).match(/^\s*(.)/);
    if (next && (next[1] === '{' || next[1] === ';') && functionHeaderName(prefix, shortName) === shortName) {
      pattern.lastIndex = closeIndex + 1;
      continue;
    }
    if (next && next[1] === ':' && /\bdef\s*$/.test(prefix)) {
      pattern.lastIndex = closeIndex + 1;
      continue;
    }
    records.push({
      callee,
      shortName,
      arguments: clean.slice(openIndex + 1, closeIndex).trim()
    });
  }
  return records;
}

function conditionRecords(source, constants, ignoredIdentifiers) {
  const clean = stripComments(source);
  const masked = maskStrings(clean);
  const pattern = /\b(if|while|switch)\s*\(/g;
  const records = [];
  let match;
  while ((match = pattern.exec(masked))) {
    const openIndex = masked.indexOf('(', match.index + match[1].length);
    const closeIndex = matchingParen(masked, openIndex);
    if (closeIndex < 0) continue;
    const expression = clean.slice(openIndex + 1, closeIndex).trim();
    records.push({
      kind: match[1],
      expression,
      calls: unique(callRecords(expression).map((item) => item.callee)),
      identifiers: unique((maskStrings(expression).match(/\b[A-Za-z_$][\w$]*\b/g) || [])
        .filter((item) => !CONTROL_WORDS.has(item))),
      fingerprint: `${match[1]}:${normalizedTokenSequence(expression, constants, ignoredIdentifiers, true)}`
    });
    pattern.lastIndex = closeIndex + 1;
  }
  const pythonPattern = /^\s*(if|elif|while)\s+(.+?)\s*:\s*$/gm;
  while ((match = pythonPattern.exec(clean))) {
    const expression = match[2].trim();
    if (/^\(.*\)$/.test(expression)) continue;
    records.push({
      kind: match[1],
      expression,
      calls: unique(callRecords(expression).map((item) => item.callee)),
      identifiers: unique((maskStrings(expression).match(/\b[A-Za-z_$][\w$]*\b/g) || [])
        .filter((item) => !CONTROL_WORDS.has(item))),
      fingerprint: `${match[1]}:${normalizedTokenSequence(expression, constants, ignoredIdentifiers, true)}`
    });
  }
  return records;
}

function constantRecords(source) {
  const clean = stripComments(source);
  const result = [];
  for (const match of clean.matchAll(/^\s*#\s*define\s+([A-Za-z_$][\w$]*)\s+([^\r\n]+)/gm)) {
    if (match[1].includes('(')) continue;
    result.push({ name: match[1], value: match[2].trim().replace(/\s+/g, '') });
  }
  for (const match of clean.matchAll(/\b(?:constexpr\s+|const\s+)(?:unsigned\s+|signed\s+)?[A-Za-z_$][\w$:<>,]*(?:\s*[*&]+)?\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\r\n]+)/g)) {
    result.push({ name: match[1], value: match[2].trim().replace(/\s+/g, '') });
  }
  for (const match of clean.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*([^#\r\n]+?)\s*$/gm)) {
    result.push({ name: match[1], value: match[2].trim().replace(/\s+/g, '') });
  }
  return unique(result.map((item) => JSON.stringify(item))).map((item) => JSON.parse(item));
}

function sideEffectCounts(calls) {
  const counts = {};
  for (const call of calls) {
    if (!SIDE_EFFECT_PATTERN.test(call.callee)) continue;
    counts[call.callee] = (counts[call.callee] || 0) + 1;
  }
  return counts;
}

function isCriticalCall(callee) {
  return CRITICAL_CALL_PATTERN.test(String(callee || ''));
}

function criticalCallRecords(calls, constants) {
  const constantMap = new Map((constants || []).map((item) => [item.name, item.value]));
  return calls
    .filter((call) => isCriticalCall(call.callee))
    .map((call) => ({
      callee: call.callee,
      arguments: call.arguments,
      normalizedArguments: normalizedTokenSequence(call.arguments, constantMap, new Set(), true)
    }));
}

function inventory(sources, ignoredIdentifiers) {
  const combined = sources.map((item) => item.text).join('\n');
  const calls = callRecords(combined);
  const constants = constantRecords(combined);
  const conditions = conditionRecords(combined, constants, ignoredIdentifiers);
  return {
    files: sources.map((item) => item.name),
    bytes: Buffer.byteLength(combined, 'utf8'),
    strings: stringLiterals(combined),
    calls: unique(calls.map((item) => item.callee)).sort(),
    guardCalls: unique(conditions.flatMap((item) => item.calls)).sort(),
    constants,
    sideEffects: sideEffectCounts(calls),
    criticalCalls: criticalCallRecords(calls, constants),
    conditions,
    conditionFingerprints: unique(conditions.map((item) => item.fingerprint)),
    controlFlow: {
      conditions: conditions.length,
      ifs: conditions.filter((item) => item.kind === 'if' || item.kind === 'elif').length,
      loops: (combined.match(/\b(?:for|while)\s*\(/g) || []).length +
        (combined.match(/^\s*(?:for|while)\b.+:\s*(?:#.*)?$/gm) || []).length,
      switches: conditions.filter((item) => item.kind === 'switch').length
    }
  };
}

function ignoredCallName(callee, ignoredIdentifiers) {
  if (!ignoredIdentifiers || ignoredIdentifiers.size === 0) return false;
  const name = String(callee || '');
  return ignoredIdentifiers.has(name) || ignoredIdentifiers.has(name.split(/\.|->|::/).pop());
}

function compareConditionRecords(sourceConditions, generatedConditions) {
  const remaining = generatedConditions.slice();
  const unmatched = [];
  for (const sourceCondition of sourceConditions) {
    const index = remaining.findIndex((candidate) => candidate.fingerprint === sourceCondition.fingerprint);
    if (index >= 0) remaining.splice(index, 1);
    else unmatched.push(sourceCondition);
  }
  const changedConditions = [];
  const missingConditions = [];
  for (const sourceCondition of unmatched) {
    const index = remaining.findIndex((candidate) => candidate.kind === sourceCondition.kind);
    if (index >= 0) {
      const generatedCondition = remaining.splice(index, 1)[0];
      changedConditions.push({
        kind: sourceCondition.kind,
        sourceExpression: sourceCondition.expression,
        generatedExpression: generatedCondition.expression,
        sourceFingerprint: sourceCondition.fingerprint,
        generatedFingerprint: generatedCondition.fingerprint
      });
    } else {
      missingConditions.push({
        kind: sourceCondition.kind,
        expression: sourceCondition.expression,
        fingerprint: sourceCondition.fingerprint
      });
    }
  }
  return { missingConditions, changedConditions };
}

function compareCriticalCallRecords(sourceCalls, generatedCalls, ignoredIdentifiers) {
  const source = sourceCalls.filter((call) => !ignoredCallName(call.callee, ignoredIdentifiers));
  const remaining = generatedCalls
    .filter((call) => !ignoredCallName(call.callee, ignoredIdentifiers))
    .slice();
  const unmatched = [];
  for (const sourceCall of source) {
    const index = remaining.findIndex((candidate) =>
      candidate.callee === sourceCall.callee &&
      candidate.normalizedArguments === sourceCall.normalizedArguments
    );
    if (index >= 0) remaining.splice(index, 1);
    else unmatched.push(sourceCall);
  }
  const changedCriticalCalls = [];
  const missingCriticalCalls = [];
  for (const sourceCall of unmatched) {
    const index = remaining.findIndex((candidate) => candidate.callee === sourceCall.callee);
    if (index >= 0) {
      const generatedCall = remaining.splice(index, 1)[0];
      changedCriticalCalls.push({
        callee: sourceCall.callee,
        sourceArguments: sourceCall.arguments,
        generatedArguments: generatedCall.arguments,
        sourceNormalizedArguments: sourceCall.normalizedArguments,
        generatedNormalizedArguments: generatedCall.normalizedArguments
      });
    } else {
      missingCriticalCalls.push({
        callee: sourceCall.callee,
        arguments: sourceCall.arguments,
        normalizedArguments: sourceCall.normalizedArguments
      });
    }
  }
  return { missingCriticalCalls, changedCriticalCalls };
}

function normalizedExact(source) {
  // Join tokens with a sentinel so `int x` cannot equal the invalid `intx`,
  // while ordinary formatting around operators remains insignificant.
  return lexTokens(source).join('\u001f');
}

function compareCode(options) {
  const sourceFiles = options.sourceFiles || [];
  const generatedPrimaryFiles = options.generatedPrimaryFiles || options.generatedFiles || [];
  const supportFiles = options.supportFiles || [];
  const generatedFiles = options.generatedFiles
    ? [...options.generatedFiles, ...supportFiles]
    : [...generatedPrimaryFiles, ...supportFiles];
  const mode = options.mode || 'report';
  const ignoredStrings = new Set(options.ignoreStrings || []);
  const ignoredIdentifiers = new Set(options.ignoreIdentifiers || []);
  const source = inventory(sourceFiles, ignoredIdentifiers);
  const generated = inventory(generatedFiles, ignoredIdentifiers);
  const generatedPrimary = inventory(generatedPrimaryFiles, ignoredIdentifiers);
  const generatedStrings = new Set(generated.strings);
  const generatedCalls = new Set(generated.calls);
  const generatedGuardCalls = new Set(generated.guardCalls);
  const generatedConstants = new Map(generated.constants.map((item) => [item.name, item.value]));

  const missingStrings = source.strings.filter((item) =>
    !ignoredStrings.has(item) && !generatedStrings.has(item)
  );
  const missingGuardCalls = source.guardCalls.filter((item) =>
    !ignoredIdentifiers.has(item) && !generatedGuardCalls.has(item)
  );
  const changedConstants = source.constants.filter((item) =>
    !ignoredIdentifiers.has(item.name) && generatedConstants.has(item.name) &&
    generatedConstants.get(item.name) !== item.value
  ).map((item) => ({ ...item, generatedValue: generatedConstants.get(item.name) }));
  const missingConstants = source.constants.filter((item) =>
    !ignoredIdentifiers.has(item.name) && !generatedConstants.has(item.name)
  );
  const missingSideEffects = Object.entries(source.sideEffects)
    .filter(([name, count]) => !ignoredIdentifiers.has(name) && (generated.sideEffects[name] || 0) < count)
    .map(([name, count]) => ({ name, sourceCount: count, generatedCount: generated.sideEffects[name] || 0 }));
  const conditionGaps = compareConditionRecords(source.conditions, generated.conditions);
  const criticalCallGaps = compareCriticalCallRecords(
    source.criticalCalls,
    generated.criticalCalls,
    ignoredIdentifiers
  );
  const requiredPatterns = (options.requiredPatterns || []).map((item, index) => {
    const descriptor = typeof item === 'string' ? { label: item, pattern: item } : item;
    let matched = false;
    let error = null;
    if (!descriptor || typeof descriptor.pattern !== 'string' || !descriptor.pattern) {
      return {
        label: descriptor && descriptor.label || `pattern-${index + 1}`,
        pattern: descriptor && descriptor.pattern || null,
        matched: false,
        error: 'pattern must be a non-empty string'
      };
    }
    try {
      const patternText = (options.includeSupportInRequiredPatterns === true
        ? generatedFiles
        : generatedPrimaryFiles).map((file) => file.text).join('\n');
      matched = new RegExp(descriptor.pattern, descriptor.flags || 'm').test(
        stripComments(patternText)
      );
    } catch (caught) {
      error = caught.message;
    }
    return { label: descriptor.label || `pattern-${index + 1}`, pattern: descriptor.pattern, matched, error };
  });
  const missingRequiredPatterns = requiredPatterns.filter((item) => !item.matched);
  const exactMatch = normalizedExact(sourceFiles.map((item) => item.text).join('\n')) ===
    normalizedExact(generatedPrimaryFiles.map((item) => item.text).join('\n'));
  const gaps = {
    missingGuardCalls,
    missingStrings,
    missingConstants,
    changedConstants,
    missingSideEffects,
    missingConditions: conditionGaps.missingConditions,
    changedConditions: conditionGaps.changedConditions,
    missingCriticalCalls: criticalCallGaps.missingCriticalCalls,
    changedCriticalCalls: criticalCallGaps.changedCriticalCalls,
    missingRequiredPatterns
  };
  const behavioralGapCount = Object.values(gaps).reduce((total, items) => total + items.length, 0);
  const passed = mode === 'exact' ? exactMatch : mode === 'behavioral-strict' ? behavioralGapCount === 0 : null;
  return {
    mode,
    passed,
    exactMatch,
    behavioralGapCount,
    source,
    generated,
    generatedPrimary,
    gaps,
    requiredPatterns,
    limitations: [
      'behavioral-strict is a conservative static audit, not a formal proof of semantic equivalence',
      'the audit does not build a full control-flow or call graph, so reachability and exact branch placement need requiredPatterns or human review',
      'critical-call and condition checks compare static token signatures; aliases and arbitrary expressions may still need requiredPatterns or human review',
      'exact compares comment-free token sequences and is expected to fail after refactoring'
    ]
  };
}

module.exports = { compareCode, inventory, stripComments, lexTokens, normalizedExact };
