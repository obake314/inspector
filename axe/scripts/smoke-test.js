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

function main() {
  runNodeCheck('server.js', join(root, 'server.js'));
  checkInlineScripts();
  runNodeCheck('gas/ReportGenerator.gs', join(root, 'gas', 'ReportGenerator.gs'), readFileSync(join(root, 'gas', 'ReportGenerator.gs'), 'utf8'));
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}
