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

function main() {
  runNodeCheck('server.js', join(root, 'server.js'));
  checkInlineScripts();
  checkScoreFormulaPolicy();
  runNodeCheck('gas/ReportGenerator.gs', join(root, 'gas', 'ReportGenerator.gs'), readFileSync(join(root, 'gas', 'ReportGenerator.gs'), 'utf8'));
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}
