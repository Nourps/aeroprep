import { Router } from 'express';
import { can, requirePerm } from '../auth.js';
import { validQuestion, insertQuestion } from '../questions.js';

// Adding a question from the revision pages: admins publish directly,
// members propose (stored inactive until an admin reviews it in Admin › Banque de questions).
const r = Router();

r.post('/', requirePerm('questions.propose'), (req, res) => {
  const admin = can(req.user, 'admin');
  const body = { ...req.body, active: admin ? req.body.active !== false : false };
  const err = validQuestion(body);
  if (err) return res.status(400).json({ error: err });
  const id = insertQuestion(body, { source: admin ? 'admin' : 'member', uid: req.user.id });
  res.json({ id, published: admin && body.active });
});

export default r;
