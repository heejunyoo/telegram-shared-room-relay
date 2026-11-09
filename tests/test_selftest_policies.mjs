import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';

// Expose the private function only in this in-memory test module, never production.
const source = readFileSync(new URL('../cloudflare/src/index.js', import.meta.url), 'utf8');
const entry = `
import relay, { selfTest } from './relay.js';
export { Transcript } from './relay.js';
export default { async fetch(request, env, ctx) {
  if (new URL(request.url).pathname === '/test-report')
    return Response.json(await selfTest(env, ctx));
  return relay.fetch(request, env, ctx);
}};`;

for (const [name, extra] of [
  ['custom agents', { AGENTS: 'alpha,beta', AGENT_TOKEN_ALPHA: 'a', AGENT_TOKEN_BETA: 'b' }],
  ['production policy', { MIN_ROOT_USER_SEQ: '635', MAX_REPLIES_PER_USER_MSG: 'unlimited', MAX_ROUNDS_PER_USER_MSG: 'unlimited' }],
  ['custom agents and restrictive policy', { AGENTS: 'alpha,beta', AGENT_TOKEN_ALPHA: 'a', AGENT_TOKEN_BETA: 'b', MIN_ROOT_USER_SEQ: '635', MAX_REPLIES_PER_USER_MSG: '1', MAX_ROUNDS_PER_USER_MSG: '5' }],
]) {
  const mf = new Miniflare({
    modulesRoot: '/test',
    modules: [
      { type: 'ESModule', path: '/test/entry.js', contents: entry },
      { type: 'ESModule', path: '/test/relay.js', contents: source + '\nexport { selfTest };' },
    ],
    compatibilityDate: '2026-08-06',
    durableObjects: { TRANSCRIPT: { className: 'Transcript', useSQLite: true } },
    bindings: { PICKLE_TOKEN: 'pk', INSTINCT_TOKEN: 'in', ...extra },
  });
  try {
    const response = await mf.dispatchFetch('https://relay.test/test-report');
    assert.equal(response.status, 200, name);
    const report = await response.json();
    assert.equal(report.total, 23, name + ': expected complete selftest');
    assert.equal(report.results.length, report.total, name + ': missing results');
    assert.equal(report.failed, 0, name + ': ' + JSON.stringify(report.failed_names));
    assert.ok(report.results.every(result => result.pass === true), name);
    console.log('PASS', name, report.total + '/' + report.total);
  } finally {
    await mf.dispose();
  }
}
