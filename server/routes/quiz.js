import { Router } from 'express';
import { db, getSetting } from '../db.js';
import { requirePerm } from '../auth.js';

const r = Router();
r.use(requirePerm('quiz'));

const SPACES = new Set(['atpl', 'a320']);
// Days until next review once a question reaches a Leitner box.
const BOX_INTERVAL_DAYS = { 1: 0, 2: 1, 3: 3, 4: 7, 5: 16, 6: 35 };

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Question as sent to the client: options shuffled, correct answer withheld. */
function clientQuestion(q, flagged = false) {
  const options = JSON.parse(q.options).map((text, idx) => ({ idx, text }));
  return {
    id: q.id, subject: q.subject_code, topic: q.topic, question: q.question,
    options: shuffle(options), difficulty: q.difficulty, reference: q.reference, flagged,
  };
}

function updateSrs(userId, questionId, correct) {
  const row = db.prepare('SELECT box FROM srs WHERE user_id = ? AND question_id = ?').get(userId, questionId);
  let box;
  if (!correct) box = 1;
  else if (!row) box = 3; // right the first time: skip the short boxes
  else box = Math.min(6, row.box + 1);
  const due = new Date(Date.now() + BOX_INTERVAL_DAYS[box] * 86400_000).toISOString().replace('T', ' ').slice(0, 19);
  db.prepare(`INSERT INTO srs (user_id, question_id, box, due_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, question_id) DO UPDATE SET box = excluded.box, due_at = excluded.due_at`)
    .run(userId, questionId, box, due);
  return box;
}

const recordAttempt = db.prepare('INSERT INTO attempts (user_id, question_id, chosen, correct, mode, exam_id) VALUES (?, ?, ?, ?, ?, ?)');

function spaceParam(req, res) {
  if (!SPACES.has(req.params.space)) { res.status(404).json({ error: 'unknown_space' }); return null; }
  return req.params.space;
}

// ---- overview of subjects with personal progress ----
r.get('/:space/subjects', (req, res) => {
  const space = spaceParam(req, res); if (!space) return;
  const rows = db.prepare(`
    SELECT s.code, s.name_en, s.name_fr,
      (SELECT COUNT(*) FROM questions q WHERE q.subject_code = s.code AND q.active = 1) AS total,
      (SELECT COUNT(DISTINCT a.question_id) FROM attempts a JOIN questions q ON q.id = a.question_id
         WHERE a.user_id = @uid AND q.subject_code = s.code AND q.active = 1) AS seen,
      (SELECT COUNT(*) FROM attempts a JOIN questions q ON q.id = a.question_id
         WHERE a.user_id = @uid AND q.subject_code = s.code) AS answered,
      (SELECT COALESCE(SUM(a.correct), 0) FROM attempts a JOIN questions q ON q.id = a.question_id
         WHERE a.user_id = @uid AND q.subject_code = s.code) AS right_answers,
      (SELECT COUNT(*) FROM srs x JOIN questions q ON q.id = x.question_id
         WHERE x.user_id = @uid AND q.subject_code = s.code AND q.active = 1 AND x.box < 6 AND x.due_at <= datetime('now')) AS due,
      (SELECT COUNT(*) FROM srs x JOIN questions q ON q.id = x.question_id
         WHERE x.user_id = @uid AND q.subject_code = s.code AND q.active = 1 AND x.box >= 5) AS mastered
    FROM subjects s WHERE s.space = @space ORDER BY s.sort`).all({ uid: req.user.id, space });
  res.json({ subjects: rows });
});

// ---- build a practice set or start an exam ----
r.post('/:space/start', (req, res) => {
  const space = spaceParam(req, res); if (!space) return;
  const mode = req.body.mode === 'exam' ? 'exam' : 'practice';
  const filter = ['all', 'unseen', 'wrong', 'due', 'flagged'].includes(req.body.filter) ? req.body.filter : 'all';
  const count = Math.max(1, Math.min(200, Number(req.body.count) || 20));
  const valid = new Set(db.prepare('SELECT code FROM subjects WHERE space = ?').all(space).map((s) => s.code));
  let subjects = Array.isArray(req.body.subjects) ? req.body.subjects.filter((s) => valid.has(s)) : [];
  if (!subjects.length) subjects = [...valid];

  const placeholders = subjects.map(() => '?').join(',');
  const uid = req.user.id;
  let where = `q.active = 1 AND q.space = ? AND q.subject_code IN (${placeholders})`;
  const params = [space, ...subjects];
  if (filter === 'unseen') { where += ' AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.user_id = ? AND a.question_id = q.id)'; params.push(uid); }
  if (filter === 'wrong') { where += ' AND EXISTS (SELECT 1 FROM srs x WHERE x.user_id = ? AND x.question_id = q.id AND x.box <= 2)'; params.push(uid); }
  if (filter === 'due') { where += " AND EXISTS (SELECT 1 FROM srs x WHERE x.user_id = ? AND x.question_id = q.id AND x.box < 6 AND x.due_at <= datetime('now'))"; params.push(uid); }
  if (filter === 'flagged') { where += ' AND EXISTS (SELECT 1 FROM flags f WHERE f.user_id = ? AND f.question_id = q.id)'; params.push(uid); }

  // Unseen questions first, then the rest at random.
  const rows = db.prepare(`SELECT q.*,
      EXISTS (SELECT 1 FROM attempts a WHERE a.user_id = ? AND a.question_id = q.id) AS seen,
      EXISTS (SELECT 1 FROM flags f WHERE f.user_id = ? AND f.question_id = q.id) AS flagged
    FROM questions q WHERE ${where} ORDER BY seen ASC, random() LIMIT ?`).all(uid, uid, ...params, count);
  const questions = shuffle(rows).map((q) => clientQuestion(q, !!q.flagged));

  if (mode === 'practice') return res.json({ mode, questions });

  if (!questions.length) return res.json({ mode, questions });
  const duration = questions.length * Number(getSetting('exam_seconds_per_question'));
  const info = db.prepare('INSERT INTO exams (user_id, space, subjects, question_ids, duration_s) VALUES (?, ?, ?, ?, ?)')
    .run(uid, space, JSON.stringify(subjects), JSON.stringify(questions.map((q) => q.id)), duration);
  res.json({ mode, examId: info.lastInsertRowid, durationSeconds: duration, passMark: Number(getSetting('exam_pass_mark')), questions });
});

// ---- practice: answer one question, get the correction immediately ----
r.post('/answer', (req, res) => {
  const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(Number(req.body.questionId));
  if (!q) return res.status(404).json({ error: 'not_found' });
  const chosen = Number.isInteger(req.body.chosen) ? req.body.chosen : null;
  const correct = chosen === q.correct;
  recordAttempt.run(req.user.id, q.id, chosen, correct ? 1 : 0, 'practice', null);
  const box = updateSrs(req.user.id, q.id, correct);
  res.json({ correct, correctIndex: q.correct, explanation: q.explanation, reference: q.reference, box });
});

// ---- exam: submit all answers at once ----
r.post('/exam/:id/submit', (req, res) => {
  const exam = db.prepare('SELECT * FROM exams WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
  if (!exam) return res.status(404).json({ error: 'not_found' });
  if (exam.finished_at) return res.status(409).json({ error: 'already_submitted' });
  const answers = req.body.answers && typeof req.body.answers === 'object' ? req.body.answers : {};
  const ids = JSON.parse(exam.question_ids);
  const getQ = db.prepare('SELECT * FROM questions WHERE id = ?');
  let right = 0;
  const results = [];
  db.transaction(() => {
    for (const id of ids) {
      const q = getQ.get(id);
      if (!q) continue;
      const chosen = Number.isInteger(answers[id]) ? answers[id] : null;
      const ok = chosen === q.correct;
      if (ok) right++;
      recordAttempt.run(req.user.id, id, chosen, ok ? 1 : 0, 'exam', exam.id);
      updateSrs(req.user.id, id, ok);
      results.push({ id, chosen, correctIndex: q.correct, correct: ok, explanation: q.explanation, reference: q.reference });
    }
    const score = ids.length ? Math.round((right / ids.length) * 1000) / 10 : 0;
    db.prepare("UPDATE exams SET answers = ?, finished_at = datetime('now'), score = ? WHERE id = ?")
      .run(JSON.stringify(answers), score, exam.id);
  })();
  const score = ids.length ? Math.round((right / ids.length) * 1000) / 10 : 0;
  const passMark = Number(getSetting('exam_pass_mark'));
  res.json({ score, right, total: ids.length, passed: score >= passMark, passMark, results });
});

// ---- flags (questions to revisit / report) ----
r.post('/flag/:id', (req, res) => {
  db.prepare(`INSERT INTO flags (user_id, question_id, note) VALUES (?, ?, ?)
    ON CONFLICT(user_id, question_id) DO UPDATE SET note = excluded.note`)
    .run(req.user.id, Number(req.params.id), String(req.body.note || '').slice(0, 1000));
  res.json({ ok: true });
});
r.delete('/flag/:id', (req, res) => {
  db.prepare('DELETE FROM flags WHERE user_id = ? AND question_id = ?').run(req.user.id, Number(req.params.id));
  res.json({ ok: true });
});

// ---- statistics ----
r.get('/:space/stats', (req, res) => {
  const space = spaceParam(req, res); if (!space) return;
  const uid = req.user.id;
  const daily = db.prepare(`SELECT date(a.created_at) AS day, COUNT(*) AS answered, SUM(a.correct) AS right_answers
    FROM attempts a JOIN questions q ON q.id = a.question_id
    WHERE a.user_id = ? AND q.space = ? AND a.created_at >= date('now', '-29 days')
    GROUP BY day ORDER BY day`).all(uid, space);
  const boxes = db.prepare(`SELECT x.box, COUNT(*) AS n FROM srs x JOIN questions q ON q.id = x.question_id
    WHERE x.user_id = ? AND q.space = ? AND q.active = 1 GROUP BY x.box ORDER BY x.box`).all(uid, space);
  const exams = db.prepare(`SELECT id, subjects, score, duration_s, started_at, finished_at,
      json_array_length(question_ids) AS total
    FROM exams WHERE user_id = ? AND space = ? AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 20`).all(uid, space)
    .map((e) => ({ ...e, subjects: JSON.parse(e.subjects) }));
  const topics = db.prepare(`SELECT q.subject_code AS subject, q.topic, COUNT(*) AS answered, SUM(a.correct) AS right_answers
    FROM attempts a JOIN questions q ON q.id = a.question_id
    WHERE a.user_id = ? AND q.space = ? AND q.topic != ''
    GROUP BY q.subject_code, q.topic HAVING answered >= 2
    ORDER BY (CAST(right_answers AS REAL) / answered) ASC LIMIT 10`).all(uid, space);
  res.json({ daily, boxes, exams, weakTopics: topics, passMark: Number(getSetting('exam_pass_mark')) });
});

export default r;
