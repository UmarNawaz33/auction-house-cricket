#!/usr/bin/env node
/* ============================================================
   tests/run.js — the test runner. No dependencies (plain Node + vm), no
   npm install needed.

   Usage:
     node tests/run.js                 run every suite
     node tests/run.js render markup    run only the named suites
     node tests/run.js --list           list available suite names and exit

   Suite names are each file's basename without ".test.js" (render, markup,
   flow, endgame, bidsteps, admin-isolation). See CLAUDE.md's "which test to
   run" table for what each one actually covers and when it's the fast path
   instead of running everything.
   ============================================================ */
const fs = require('fs');
const path = require('path');
const { printSummary } = require('./lib/suite');

const TEST_DIR = __dirname;

function discoverSuites(){
  return fs.readdirSync(TEST_DIR)
    .filter(f => f.endsWith('.test.js'))
    .map(f => {
      const mod = require(path.join(TEST_DIR, f));
      return { file: f, name: mod.name || f.replace(/\.test\.js$/, ''), run: mod.run };
    });
}

async function main(){
  const args = process.argv.slice(2);
  const all = discoverSuites();

  if (args.includes('--list')){
    console.log('Available suites:');
    for (const s of all) console.log('  ' + s.name + '  (' + s.file + ')');
    return 0;
  }

  const wanted = args.filter(a => !a.startsWith('--'));
  const suites = wanted.length
    ? all.filter(s => wanted.includes(s.name))
    : all;

  const missing = wanted.filter(w => !all.some(s => s.name === w));
  if (missing.length){
    console.log('Unknown suite name(s): ' + missing.join(', '));
    console.log('Run with --list to see available suites.');
    return 1;
  }

  let exitCode = 0;
  let totalChecks = 0, totalFailed = 0;
  const failedSuites = [];

  for (const suite of suites){
    const summary = await suite.run();
    exitCode |= printSummary(summary);
    totalChecks += summary.total;
    totalFailed += summary.failed;
    if (summary.failed) failedSuites.push(summary.name);
    console.log(''); // blank line between suites
  }

  console.log('='.repeat(50));
  if (suites.length > 1){
    console.log(
      totalFailed
        ? `OVERALL: ${totalFailed}/${totalChecks} checks failed across ${failedSuites.length} suite(s): ${failedSuites.join(', ')}`
        : `OVERALL: all ${totalChecks} checks passed across ${suites.length} suite(s)`
    );
  }

  return exitCode;
}

main().then(code => process.exit(code)).catch(e => {
  console.error('Test runner crashed:', e);
  process.exit(1);
});
