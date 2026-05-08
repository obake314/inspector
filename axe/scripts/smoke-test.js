const { readFileSync } = require('fs');
const { join } = require('path');
const { spawnSync } = require('child_process');
const vm = require('vm');

const root = join(__dirname, '..');

function runNodeCheck(label, filePath, input) {
  const args = input === undefined
    ? ['--check', filePath]
    : ['--check', '--input-type=commonjs'];
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    input,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${label} syntax check failed\n${detail}`);
  }
  console.log(`ok - ${label}`);
}

function checkInlineScripts() {
  const htmlPath = join(root, 'public', 'index.html');
  const html = readFileSync(htmlPath, 'utf8');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(([, attrs]) => !/\bsrc\s*=/i.test(attrs))
    .map(([, , code]) => code.trim())
    .filter(Boolean);

  if (scripts.length === 0) {
    throw new Error('No inline scripts found in public/index.html');
  }

  scripts.forEach((code, index) => {
    new vm.Script(code, { filename: `public/index.html<script ${index + 1}>` });
  });
  console.log(`ok - public/index.html inline scripts (${scripts.length})`);
}

function checkScoreFormulaPolicy() {
  const htmlPath = join(root, 'public', 'index.html');
  const html = readFileSync(htmlPath, 'utf8');

  const requiredSnippets = [
    'function calculateScanAchievementRate(pass, total, unverified)',
    'const verified = Math.max(0, (total || 0) - (unverified || 0));',
    "normalizeScoreToTarget(basicScore, { mode: 'scan' })",
    "normalizeScoreToTarget(deepScore, { mode: 'scan' })",
    "normalizeScoreToTarget(multiScore, { mode: 'scan' })",
    "normalizeScoreToTarget(playScore, { mode: 'scan' })",
    "normalizeScoreToTarget(extScore, { mode: 'scan' })",
    "normalizeScoreToTarget(totalScore, { mode: 'total' })"
  ];

  requiredSnippets.forEach(snippet => {
    if (!html.includes(snippet)) {
      throw new Error(`Score formula policy check failed: missing ${snippet}`);
    }
  });

  function extractFunction(name) {
    const start = html.indexOf(`function ${name}`);
    if (start < 0) throw new Error(`Score formula policy check failed: missing ${name}`);
    const braceStart = html.indexOf('{', start);
    let depth = 0;
    for (let i = braceStart; i < html.length; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}') {
        depth--;
        if (depth === 0) return html.slice(start, i + 1);
      }
    }
    throw new Error(`Score formula policy check failed: unterminated ${name}`);
  }

  ['computeBasicScore', 'computeDeepScore', 'computePlayScore', 'computeExtScore', 'computeMultiScore']
    .forEach(name => {
      const body = extractFunction(name);
      if (body.includes('calculateAchievementRate(pass, getTargetScList().length')) {
        throw new Error(`Score formula policy check failed: ${name} uses fixed-total achievement rate`);
      }
      if (!body.includes('calculateScanAchievementRate')) {
        throw new Error(`Score formula policy check failed: ${name} does not use scan achievement rate`);
      }
    });

  console.log('ok - score formula policy');
}

function checkApiAndRescanPolicy() {
  const html = readFileSync(join(root, 'public', 'index.html'), 'utf8');
  const server = readFileSync(join(root, 'server.js'), 'utf8');

  const htmlSnippets = [
    'const apiUrl = (path) => path;',
    'function getAlternateApiUrl(url)',
    'buildFetchOptions()',
    "rescanBatchFromScoreTable('${scanType}', '${viewScope}', this)",
    'function getBatchScoreRescanContexts(view =',
    'function buildBatchScoreRescanContext(record, store, view, viewportPreset, navConsistency)',
    'renderScore !== false',
    'ALL'
  ];
  htmlSnippets.forEach(snippet => {
    if (!html.includes(snippet)) {
      throw new Error(`API/rescan policy check failed: missing ${snippet}`);
    }
  });

  const serverSnippets = [
    "if (req.url.startsWith('/axe/api/'))",
    "app.all('/api/playwright-check'",
    'PLAYWRIGHT APIはPOSTのみ対応しています',
    "app.post('/api/request-reset'",
    "app.post('/api/reset-password'",
    'RESET_TOKEN_TTL = 5 * 60 * 1000'
  ];
  serverSnippets.forEach(snippet => {
    if (!server.includes(snippet)) {
      throw new Error(`API/rescan policy check failed: missing ${snippet}`);
    }
  });

  console.log('ok - API/rescan policy');
}

function checkContrastFallbackPolicy() {
  const html = readFileSync(join(root, 'public', 'index.html'), 'utf8');
  const server = readFileSync(join(root, 'server.js'), 'utf8');

  const snippets = [
    'function getColorContrastOverlapTargets(results, limit = 25)',
    'function applyColorContrastOverlapFallback(page, results)',
    'color-contrast-overlap-fallback',
    'data-a11y-inspector-contrast-target',
    'await applyColorContrastOverlapFallback(page, results);'
  ];
  snippets.forEach(snippet => {
    if (!server.includes(snippet) && !html.includes(snippet)) {
      throw new Error(`Contrast fallback policy check failed: missing ${snippet}`);
    }
  });

  console.log('ok - contrast fallback policy');
}

function checkScreenReaderContrastPolicy() {
  const server = readFileSync(join(root, 'server.js'), 'utf8');
  const snippets = [
    'function isIgnoredContrastElement(el)',
    'function visibleTextForDesc(el',
    "current.getAttribute('aria-hidden') === 'true'",
    'hasSrOnlyMarker(current)',
    'isIgnoredContrastElement(node)'
  ];
  snippets.forEach(snippet => {
    if (!server.includes(snippet)) {
      throw new Error(`Screen-reader contrast policy check failed: missing ${snippet}`);
    }
  });
  console.log('ok - screen-reader contrast policy');
}

function checkRequiredIndicatorPolicy() {
  const server = readFileSync(join(root, 'server.js'), 'utf8');
  const snippets = [
    'const REQUIRED_WORD_RE = /(必須|要入力|required|mandatory)/i;',
    'const ALL_REQUIRED_RE =',
    'function hasRequiredCue(el)',
    'missingRequiredIndicators.push',
    '必須表示なし'
  ];
  snippets.forEach(snippet => {
    if (!server.includes(snippet)) {
      throw new Error(`Required indicator policy check failed: missing ${snippet}`);
    }
  });
  console.log('ok - required indicator policy');
}

function checkRedundantEntryPolicy() {
  const server = readFileSync(join(root, 'server.js'), 'utf8');
  const snippets = [
    'checkbox/radio の同一 name や name[] は通常の選択肢グループ',
    'function cssPath(el)',
    '検出箇所:',
    "if (isChoiceType(type)) return true;",
    "if (/\\[\\]$/.test(el.name || '')) return true;",
    "status: 'manual_required',",
    'DEEPのmanual_required候補だけで不合格にせず'
  ];
  snippets.forEach(snippet => {
    if (!server.includes(snippet)) {
      throw new Error(`Redundant entry policy check failed: missing ${snippet}`);
    }
  });
  console.log('ok - redundant entry policy');
}

function checkFocusIndicatorPolicy() {
  const server = readFileSync(join(root, 'server.js'), 'utf8');
  const snippets = [
    'function visualCandidates(el)',
    'function evaluateIndicator(before, after)',
    'フォーカス表示が弱い',
    'function isVisibleSnapshot(st)',
    'opacity:${a.opacity}',
    "el.closest('label')"
  ];
  snippets.forEach(snippet => {
    if (!server.includes(snippet)) {
      throw new Error(`Focus indicator policy check failed: missing ${snippet}`);
    }
  });
  console.log('ok - focus indicator policy');
}

function main() {
  runNodeCheck('server.js', join(root, 'server.js'));
  checkInlineScripts();
  checkScoreFormulaPolicy();
  checkApiAndRescanPolicy();
  checkContrastFallbackPolicy();
  checkScreenReaderContrastPolicy();
  checkRequiredIndicatorPolicy();
  checkRedundantEntryPolicy();
  checkFocusIndicatorPolicy();
  runNodeCheck('gas/ReportGenerator.gs', join(root, 'gas', 'ReportGenerator.gs'), readFileSync(join(root, 'gas', 'ReportGenerator.gs'), 'utf8'));
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}
