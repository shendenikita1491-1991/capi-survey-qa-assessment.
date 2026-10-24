/**
 * Proves the API suite catches the "overwrite by local_id" bug.
 * Runs the API tests against MOCK_BUG=overwrite and checks that the RIGHT tests fail
 * (not just "something failed" - e.g. a server that didn't start would also fail everything).
 *
 *   npm run verify:buggy
 */
const { spawnSync } = require('child_process');

const MUST_FAIL = [
  'Ankit and Pooja both sync School_1 -> two separate server records, nothing overwritten',
  'both devices sync at the exact same moment (race) -> still two intact records',
  're-sending the same batch does not create a duplicate and returns the same server_id',
];
const MUST_PASS = ['rejects missing device_id with 400 and nothing is stored', 'rejects malformed JSON with 400'];

const run = spawnSync(process.execPath, [require.resolve('@playwright/test/cli'), 'test', '--project=api', '--reporter=json'], {
  env: { ...process.env, MOCK_BUG: 'overwrite', PORT: '3457' },
  encoding: 'utf8',
  maxBuffer: 50 * 1024 * 1024,
});

let report;
try { report = JSON.parse(run.stdout); } catch {
  console.error('Could not read the Playwright JSON report.\n', run.stderr);
  process.exit(1);
}

const results = {};
(function walk(suites) {
  for (const s of suites || []) {
    for (const spec of s.specs || []) results[spec.title] = spec.ok ? 'passed' : 'failed';
    walk(s.suites);
  }
})(report.suites);

const failed = Object.keys(results).filter(t => results[t] === 'failed');
const problems = [
  ...MUST_FAIL.filter(t => results[t] !== 'failed').map(t => `expected to FAIL but did not: ${t}`),
  ...MUST_PASS.filter(t => results[t] !== 'passed').map(t => `expected to PASS but did not: ${t}`),
];

console.log(`Against the buggy server: ${failed.length} of ${Object.keys(results).length} API tests failed.`);
failed.forEach(t => console.log(`  x ${t}`));
if (problems.length) {
  console.error('\nVERIFY FAILED:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log('\nOK - the suite detects the overwrite bug, and validation tests are unaffected.');
