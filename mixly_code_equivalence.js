'use strict';

const CONTROL_WORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'sizeof', 'typeof', 'return',
  'new', 'delete', 'static_cast', 'reinterpret_cast', 'const_cast',
  'dynamic_cast', 'F'
]);

const SIDE_EFFECT_PATTERN = /(?:^|\.|->|::)(?:begin|end|init|print|println|printf|write|put|update|remove|clear|display|send|play|stop|restart|commit|flush|setups?|delay|delayMicroseconds|pinMode|digitalWrite|analogWrite|tone|noTone)$/i;

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

function stringLiterals(source) {
  const values = [];
  const pattern = /(?:u8|u|U|L)?"((?:\\.|[^"\\])*)"|(?:u8|u|U|L)?'((?:\\.|[^'\\])*)'/g;
  for (const match of String(source || '').matchAll(pattern)) {
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

function functionHeaderName(prefix) {
  const match = String(prefix).match(/(?:^|[;{}]\s*)(?:template\s*<[^>]+>\s*)?(?:(?:static|inline|virtual|constexpr|const|volatile|unsigned|signed)\s+)*(?:[A-Za-z_$][\w$]*(?:::[A-Za-z_$][\w$]*)?(?:\s*[*&]+)?\s+)([A-Za-z_$][\w$]*)\s*$/);
  return match ? match[1] : null;
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
    if (next && next[1] === '{' && functionHeaderName(prefix) === shortName) {
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

function conditionRecords(source) {
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
        .filter((item) => !CONTROL_WORDS.has(item)))
    });
    pattern.lastIndex = closeIndex + 1;
  }
  const pythonPattern = /^\s*(if|while)\s+(.+?)\s*:\s*$/gm;
  while ((match = pythonPattern.exec(clean))) {
    const expression = match[2].trim();
    if (/^\(.*\)$/.test(expression)) continue;
    records.push({
      kind: match[1],
      expression,
      calls: unique(callRecords(expression).map((item) => item.callee)),
      identifiers: unique((maskStrings(expression).match(/\b[A-Za-z_$][\w$]*\b/g) || [])
        .filter((item) => !CONTROL_WORDS.has(item)))
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

function inventory(sources) {
  const combined = sources.map((item) => item.text).join('\n');
  const calls = callRecords(combined);
  const conditions = conditionRecords(combined);
  return {
    files: sources.map((item) => item.name),
    bytes: Buffer.byteLength(combined, 'utf8'),
    strings: stringLiterals(combined),
    calls: unique(calls.map((item) => item.callee)).sort(),
    guardCalls: unique(conditions.flatMap((item) => item.calls)).sort(),
    constants: constantRecords(combined),
    sideEffects: sideEffectCounts(calls),
    controlFlow: {
      conditions: conditions.length,
      ifs: conditions.filter((item) => item.kind === 'if').length,
      loops: (combined.match(/\b(?:for|while)\s*\(/g) || []).length +
        (combined.match(/^\s*(?:for|while)\b.+:\s*(?:#.*)?$/gm) || []).length,
      switches: conditions.filter((item) => item.kind === 'switch').length
    }
  };
}

function normalizedExact(source) {
  const text = stripComments(source);
  let result = '';
  let quote = null;
  let escaped = false;
  for (const current of text) {
    if (quote) {
      result += current;
      if (escaped) escaped = false;
      else if (current === '\\') escaped = true;
      else if (current === quote) quote = null;
    } else if (current === '"' || current === "'") {
      quote = current;
      result += current;
    } else if (!/\s/.test(current)) {
      result += current;
    }
  }
  return result;
}

function compareCode(options) {
  const sourceFiles = options.sourceFiles || [];
  const generatedFiles = options.generatedFiles || [];
  const mode = options.mode || 'report';
  const ignoredStrings = new Set(options.ignoreStrings || []);
  const ignoredIdentifiers = new Set(options.ignoreIdentifiers || []);
  const source = inventory(sourceFiles);
  const generated = inventory(generatedFiles);
  const generatedStrings = new Set(generated.strings);
  const generatedCalls = new Set(generated.calls);
  const generatedGuardCalls = new Set(generated.guardCalls);
  const generatedConstants = new Map(generated.constants.map((item) => [item.name, item.value]));

  const missingStrings = source.strings.filter((item) =>
    !ignoredStrings.has(item) && !generatedStrings.has(item)
  );
  const missingGuardCalls = source.guardCalls.filter((item) =>
    !ignoredIdentifiers.has(item) && !generatedGuardCalls.has(item) && !generatedCalls.has(item)
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
      matched = new RegExp(descriptor.pattern, descriptor.flags || 'm').test(
        generatedFiles.map((file) => file.text).join('\n')
      );
    } catch (caught) {
      error = caught.message;
    }
    return { label: descriptor.label || `pattern-${index + 1}`, pattern: descriptor.pattern, matched, error };
  });
  const missingRequiredPatterns = requiredPatterns.filter((item) => !item.matched);
  const exactMatch = normalizedExact(sourceFiles.map((item) => item.text).join('\n')) ===
    normalizedExact(generatedFiles.map((item) => item.text).join('\n'));
  const gaps = {
    missingGuardCalls,
    missingStrings,
    missingConstants,
    changedConstants,
    missingSideEffects,
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
    gaps,
    requiredPatterns,
    limitations: [
      'behavioral-strict is a conservative static audit, not a formal proof of semantic equivalence',
      'the audit does not build a full control-flow or call graph, so reachability and exact branch placement need requiredPatterns or human review',
      'exact compares comment-free, whitespace-free source text and is expected to fail after refactoring'
    ]
  };
}

module.exports = { compareCode, inventory, stripComments };
