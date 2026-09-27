/* ============================================================
   tests/lib/suite.js — tiny shared assertion/reporting helper so every test
   file prints in the same format and tests/run.js can total results across
   files without each one reimplementing a checklist.
   ============================================================ */

function makeSuite(name){
  const results = [];
  let group = null;

  function section(label){
    group = label;
    results.push({ kind: 'section', label });
  }

  function check(label, cond, detail){
    results.push({ kind: 'check', label, pass: !!cond, detail, group });
  }

  function summarize(){
    const checks = results.filter(r => r.kind === 'check');
    const failed = checks.filter(r => !r.pass);
    return { name, total: checks.length, failed: failed.length, results };
  }

  function print(){
    for (const r of results){
      if (r.kind === 'section') console.log('\n' + r.label);
      else console.log('  ' + (r.pass ? 'ok  ' : 'FAIL') + '  ' + r.label + (!r.pass && r.detail ? '  -> ' + r.detail : ''));
    }
    const { total, failed } = summarize();
    console.log('\n' + name + ': ' + (failed ? failed + '/' + total + ' FAILED' : total + '/' + total + ' passed'));
  }

  return { section, check, summarize, print };
}

/** Print a summary object (as returned by suite.summarize()) the same way
 *  every test file and the runner report results, and return its exit code. */
function printSummary(summary){
  for (const r of summary.results){
    if (r.kind === 'section') console.log('\n' + r.label);
    else console.log('  ' + (r.pass ? 'ok  ' : 'FAIL') + '  ' + r.label + (!r.pass && r.detail ? '  -> ' + r.detail : ''));
  }
  console.log('\n' + summary.name + ': ' + (summary.failed ? summary.failed + '/' + summary.total + ' FAILED' : summary.total + '/' + summary.total + ' passed'));
  return summary.failed ? 1 : 0;
}

module.exports = { makeSuite, printSummary };
