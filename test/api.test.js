import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}/api`;
let server;
let dataDir;

function client() {
  let cookie = '';
  return async (p, { method = 'GET', body } = {}) => {
    const res = await fetch(BASE + p, {
      method,
      headers: { 'x-requested-with': 'aeroprep', 'content-type': 'application/json', cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeroprep-test-'));
  server = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server/index.js"], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, ANTHROPIC_API_KEY: '' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) return; } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});

after(() => {
  server.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('accounts, roles and permissions', async () => {
  const admin = client();
  const r1 = await admin('/auth/register', { method: 'POST', body: { email: 'admin@test.fr', password: 'correct-horse-1' } });
  assert.equal(r1.body.user.role, 'admin', 'first account is admin');

  const friend = client();
  const r2 = await friend('/auth/register', { method: 'POST', body: { email: 'friend@test.fr', password: 'correct-horse-2' } });
  assert.equal(r2.body.user.role, 'pending');
  assert.equal((await friend('/docs')).status, 403, 'pending users cannot read documents');
  assert.equal((await friend('/admin/users')).status, 403);
  assert.equal((await friend('/jobs', { method: 'POST', body: { url: 'https://x.test', title: 't' } })).status, 403);

  // CSRF: mutating call without the custom header is refused
  const raw = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(raw.status, 403);

  const users = (await admin('/admin/users')).body.users;
  const id = users.find((u) => u.email === 'friend@test.fr').id;
  await admin(`/admin/users/${id}`, { method: 'PATCH', body: { role: 'member' } });
  assert.equal((await friend('/docs')).status, 200, 'member can read documents');

  const bad = await client()('/auth/login', { method: 'POST', body: { email: 'friend@test.fr', password: 'nope-nope-nope' } });
  assert.equal(bad.status, 401);
});

test('practice and exam flows with spaced repetition', async () => {
  const u = client();
  await u('/auth/login', { method: 'POST', body: { email: 'admin@test.fr', password: 'correct-horse-1' } });
  const subjects = (await u('/quiz/atpl/subjects')).body.subjects;
  assert.equal(subjects.length, 13);
  assert.ok(subjects.every((s) => s.total >= 10));

  const start = await u('/quiz/atpl/start', { method: 'POST', body: { mode: 'practice', subjects: ['050'], count: 5 } });
  assert.equal(start.body.questions.length, 5);
  const q = start.body.questions[0];
  assert.equal(q.correct, undefined, 'answer is not leaked');
  const ans = await u('/quiz/answer', { method: 'POST', body: { questionId: q.id, chosen: 0 } });
  assert.equal(typeof ans.body.correct, 'boolean');
  assert.ok(ans.body.explanation.length > 10);

  // Answer wrong on purpose -> appears in "due"
  const wrongChoice = (ans.body.correctIndex + 1) % 4;
  await u('/quiz/answer', { method: 'POST', body: { questionId: q.id, chosen: wrongChoice } });
  const due = await u('/quiz/atpl/start', { method: 'POST', body: { mode: 'practice', filter: 'due', count: 50 } });
  assert.ok(due.body.questions.some((x) => x.id === q.id));

  const exam = await u('/quiz/a320/start', { method: 'POST', body: { mode: 'exam', count: 10 } });
  assert.ok(exam.body.examId);
  assert.equal(exam.body.durationSeconds, 750);
  const answers = Object.fromEntries(exam.body.questions.map((x) => [x.id, 0]));
  const res = await u(`/quiz/exam/${exam.body.examId}/submit`, { method: 'POST', body: { answers } });
  assert.equal(res.body.total, 10);
  assert.equal((await u(`/quiz/exam/${exam.body.examId}/submit`, { method: 'POST', body: { answers } })).status, 409);
  const stats = await u('/quiz/a320/stats');
  assert.equal(stats.body.exams.length, 1);
});

test('jobs: manual add, filters, marks', async () => {
  const u = client();
  await u('/auth/login', { method: 'POST', body: { email: 'friend@test.fr', password: 'correct-horse-2' } });
  // Form fields left on "auto"/empty must fall back to automatic classification.
  const add = await u('/jobs', { method: 'POST', body: { url: 'https://www.linkedin.com/jobs/view/1', title: 'Non Type Rated First Officer A320', company: 'Test Air', description: 'Min 250 hours, type rating provided', category: 'auto', type_rating: 'auto', aircraft: '', min_hours: '' } });
  assert.equal(add.status, 200);
  await u('/jobs', { method: 'POST', body: { url: 'https://example.org/2', title: 'Captain B737', description: 'Minimum 4000 hours' } });
  const dup = await u('/jobs', { method: 'POST', body: { url: 'https://example.org/2', title: 'x' } });
  assert.equal(dup.status, 409);

  let list = (await u('/jobs?aircraft=a320&typeRating=not_required')).body.jobs;
  assert.equal(list.length, 1);
  assert.equal(list[0].min_hours, 250);
  assert.equal(list[0].category, 'low_hours');
  list = (await u('/jobs?myHours=300')).body.jobs;
  assert.deepEqual(list.map((j) => j.title), ['Non Type Rated First Officer A320']);
  list = (await u('/jobs?category=captain')).body.jobs;
  assert.equal(list.length, 1);

  await u(`/jobs/${add.body.id}/mark`, { method: 'POST', body: { status: 'saved' } });
  list = (await u('/jobs?status=saved')).body.jobs;
  assert.equal(list.length, 1);

  const preview = await u('/jobs/preview', { method: 'POST', body: { url: 'https://www.linkedin.com/jobs/view/1' } });
  assert.equal(preview.body.fetched, false);
  const ssrf = await u('/jobs/preview', { method: 'POST', body: { url: 'http://127.0.0.1:22/' } });
  assert.equal(ssrf.body.reason, 'private_address');
});

test('AI endpoint refuses cleanly when no key is configured', async () => {
  const u = client();
  await u('/auth/login', { method: 'POST', body: { email: 'admin@test.fr', password: 'correct-horse-1' } });
  const r = await u('/ai/ask', { method: 'POST', body: { question: 'What does the PTU do?' } });
  assert.equal(r.status, 503);
  assert.equal(r.body.error, 'ai_not_configured');
});

test('admin question import and quotas', async () => {
  const u = client();
  await u('/auth/login', { method: 'POST', body: { email: 'admin@test.fr', password: 'correct-horse-1' } });
  const imp = await u('/admin/questions/import', { method: 'POST', body: [
    { subject: 'A29', question: 'Imported question?', options: ['a', 'b', 'c', 'd'], correct: 2, explanation: 'because' },
    { subject: 'ZZZ', question: 'bad', options: ['a'], correct: 0 },
  ] });
  assert.equal(imp.body.added, 1);
  assert.equal(imp.body.errors.length, 1);
  await u('/admin/settings', { method: 'PUT', body: { quota_member: '3', ai_effort: 'bogus' } });
  const s = (await u('/admin/settings')).body.settings;
  assert.equal(s.quota_member, '3');
  assert.equal(s.ai_effort, 'medium');
});

test('questions: CSV import from Excel and member proposals', async () => {
  const admin = client();
  await admin('/auth/login', { method: 'POST', body: { email: 'admin@test.fr', password: 'correct-horse-1' } });
  const csv = '﻿matiere;theme;question;A;B;C;D;bonne_reponse;explication\r\n'
    + '50;Fog;"Radiation fog forms; mostly at night?";Yes;No;;;A;"Clear sky, light wind"\r\n'
    + 'a29;PTU;What drives the PTU?;Elec;Hyd ΔP;Bleed;RAT;b;x\r\n'
    + 'ZZ;x;Bad subject here;a;b;c;d;A;x\r\n'
    + '010;x;Missing answer key;a;b;c;d;;x\r\n';
  const res = await admin('/admin/questions/import', { method: 'POST', body: { csv } });
  assert.equal(res.body.added, 2, JSON.stringify(res.body));
  assert.deepEqual(res.body.errors.map((e) => [e.line, e.error]), [[4, 'invalid_subject'], [5, 'invalid_correct']]);
  const qs = (await admin('/admin/questions?space=atpl&subject=050&q=Radiation%20fog%20forms')).body.questions;
  assert.equal(qs.length, 1);
  assert.deepEqual(qs[0].options, ['Yes', 'No']);
  assert.equal(qs[0].question, 'Radiation fog forms; mostly at night?');

  const bad = await admin('/admin/questions/import', { method: 'POST', body: { csv: 'foo;bar\n1;2\n' } });
  assert.equal(bad.body.error, 'missing_columns');

  // A member proposes: stored inactive; a pending user cannot propose.
  const member = client();
  await member('/auth/login', { method: 'POST', body: { email: 'friend@test.fr', password: 'correct-horse-2' } });
  const p = await member('/questions', { method: 'POST', body: { subject_code: 'A27', question: 'Proposed by a member?', options: ['a', 'b'], correct: 1, active: true } });
  assert.equal(p.body.published, false);
  const inactive = (await admin('/admin/questions?active=0&q=Proposed%20by')).body.questions;
  assert.equal(inactive[0].source, 'member');
  const pending = client();
  await pending('/auth/register', { method: 'POST', body: { email: 'new@test.fr', password: 'correct-horse-3' } });
  assert.equal((await pending('/questions', { method: 'POST', body: {} })).status, 403);
});
