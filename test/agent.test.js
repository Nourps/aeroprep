import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Fake Anthropic Messages API: answers according to the custom tool offered in the request.
const calls = [];
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const j = JSON.parse(body);
    calls.push(j);
    const toolNames = (j.tools || []).map((t) => t.name);
    const turn = j.messages.length; // 1 = first call, then grows
    const usage = { input_tokens: 1000, output_tokens: 200, server_tool_use: { web_search_requests: 2 } };
    const search = [{ type: 'server_tool_use', id: 'srv1', name: 'web_search', input: { query: 'pilot jobs' } },
      { type: 'web_search_tool_result', tool_use_id: 'srv1', content: [] }];
    let out;
    if (turn === 1) out = { stop_reason: 'pause_turn', content: search }; // exercise pause_turn resume
    else if (j.messages.at(-1).role === 'assistant') {
      if (toolNames.includes('save_job_offers')) {
        out = { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu1', name: 'save_job_offers', input: { offers: [
          { title: 'A320 Non Type Rated First Officer', company: 'Wizz Air', url: 'https://pilotsglobal.com/job/abc', location: 'Budapest, HU', category: 'low_hours',
            type_rating: 'not_required', aircraft: ['a320'], min_hours: 200, salary: '€3,000/month', posted_date: '2026-10-01', source_site: 'pilotsglobal.com', summary: 'FO sans QT.' },
          { title: 'Invented', company: 'X', url: 'javascript:alert(1)', location: '', category: 'unknown', type_rating: 'unknown', aircraft: [], min_hours: 0, salary: '', posted_date: '', source_site: '', summary: '' },
        ] } }] };
      } else if (toolNames.includes('update_card')) {
        out = { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu2', name: 'update_card', input: {
          summary: 'Résumé IA', body: '**Nouveau** contenu', salary_fo: '40 000 €', salary_cpt: '', sources: [{ title: 'ok', url: 'https://example.org' }, { title: 'bad', url: 'ftp://x' }] } }] };
      } else if (toolNames.includes('save_questions')) {
        out = { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu3', name: 'save_questions', input: { questions: [
          { topic: 'Fog', question: 'Researched question?', options: ['a', 'b', 'c', 'd'], correct: 2, explanation: 'e', difficulty: 2, reference: 'https://skybrary.aero' },
          { topic: 'x', question: 'Bad one', options: ['a', 'b'], correct: 0, explanation: '', difficulty: 1, reference: '' },
        ] } }] };
      }
    } else out = { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Terminé.' }] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: `m${calls.length}`, type: 'message', role: 'assistant', model: j.model, usage, ...out }));
  });
});

const PORT = 3800 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}/api`;
let server; let dataDir; let cookie = '';
const api = async (p, { method = 'GET', body } = {}) => {
  const r = await fetch(BASE + p, { method, headers: { 'x-requested-with': 'aeroprep', 'content-type': 'application/json', cookie }, body: body && JSON.stringify(body) });
  const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
  return { status: r.status, body: await r.json().catch(() => null) };
};
const waitFor = async (fn) => { for (let i = 0; i < 60; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error('timeout'); };

before(async () => {
  await new Promise((r) => mock.listen(0, r));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeroprep-agent-'));
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, ANTHROPIC_API_KEY: 'test', ANTHROPIC_BASE_URL: `http://127.0.0.1:${mock.address().port}` },
    stdio: 'ignore',
  });
  await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok; } catch { return false; } });
  await api('/auth/register', { method: 'POST', body: { email: 'admin@test.fr', password: 'correct-horse-1' } });
});
after(() => { server.kill(); mock.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('seeded context cards are served and linked to job companies', async () => {
  const { body } = await api('/insights');
  assert.ok(body.insights.length >= 20);
  const wizz = body.insights.find((c) => c.key === 'airline-wizz-air');
  assert.match(wizz.match, /Wizz Air/);
  assert.ok(wizz.sources.length > 0);
});

test('job agent saves valid offers only, handles pause_turn and logs web searches', async () => {
  assert.equal((await api('/admin/agent/jobs', { method: 'POST' })).body.started, true);
  await waitFor(async () => (await api('/admin/agent')).body.runs.some((r) => r.task === 'jobs' && r.status !== 'running'));
  const run = (await api('/admin/agent')).body.runs.find((r) => r.task === 'jobs');
  assert.equal(run.status, 'ok', run.detail);
  const jobs = (await api('/jobs')).body.jobs;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].category, 'low_hours');
  assert.equal(jobs[0].min_hours, 200);
  assert.equal(jobs[0].source_name, 'IA · pilotsglobal.com');
  const jobCalls = calls.filter((c) => c.tools?.some((t) => t.name === 'save_job_offers'));
  assert.ok(jobCalls[0].tools.some((t) => t.type === 'web_search_20260209'));
  assert.equal(jobCalls[1].messages.length, 2, 'pause_turn resumed without an extra user message');
  const usage = (await api('/admin/usage')).body.recent.find((r) => r.kind === 'agent-jobs');
  assert.ok(usage.web_searches >= 4);
});

test('insight refresh updates the card and drops invalid source URLs', async () => {
  await api('/insights/airline-vueling/refresh', { method: 'POST' });
  await waitFor(async () => (await api('/insights')).body.insights.find((c) => c.key === 'airline-vueling').updated_by === 'ai');
  const card = (await api('/insights')).body.insights.find((c) => c.key === 'airline-vueling');
  assert.equal(card.summary, 'Résumé IA');
  assert.deepEqual(card.sources.map((s) => s.url), ['https://example.org']);
  // A locked card is left alone by the agent
  await api('/insights/airline-saudia', { method: 'PUT', body: { locked: true, summary: 'manuel' } });
  await api('/insights/airline-saudia/refresh', { method: 'POST' });
  await new Promise((r) => setTimeout(r, 800));
  assert.equal((await api('/insights')).body.insights.find((c) => c.key === 'airline-saudia').summary, 'manuel');
});

test('web question generation stores inactive questions for review', async () => {
  await waitFor(async () => !(await api('/admin/agent')).body.runs.some((r) => r.status === 'running'));
  assert.equal((await api('/admin/agent/questions', { method: 'POST', body: { subject: '050', count: 2 } })).body.started, true);
  await waitFor(async () => (await api('/admin/questions?active=0&q=Researched')).body.questions.length === 1);
  const q = (await api('/admin/questions?active=0&q=Researched')).body.questions[0];
  assert.equal(q.source, 'ai-web');
  assert.equal(q.reference, 'https://skybrary.aero');
});

test('duckdns settings are write-only for the token', async () => {
  await api('/admin/settings', { method: 'PUT', body: { duckdns_domain: 'https://MonAero.duckdns.org/', duckdns_token: 'abc' } });
  const s = (await api('/admin/settings')).body;
  assert.equal(s.settings.duckdns_domain, 'monaero');
  assert.equal(s.duckdns.hasToken, true);
  assert.equal(JSON.stringify(s).includes('"abc"'), false);
});
