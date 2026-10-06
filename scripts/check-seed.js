// Validates the question banks in seed/: unique keys, known subjects, well-formed options.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const subjects = new Set(['010', '021', '022', '031', '032', '033', '040', '050', '061', '062', '070', '081', '090',
  'A20', 'A21', 'A22', 'A24', 'A26', 'A27', 'A28', 'A29', 'A30', 'A31', 'A32', 'A34', 'A35', 'A36', 'A49', 'A70', 'A99']);
const keys = new Set();
const perSubject = {};
const errors = [];

for (const file of fs.readdirSync(path.join(root, 'seed')).filter((f) => f.endsWith('.json'))) {
  const items = JSON.parse(fs.readFileSync(path.join(root, 'seed', file), 'utf8'));
  for (const q of items) {
    const where = `${file}:${q.key}`;
    if (!q.key || keys.has(q.key)) errors.push(`${where} duplicate or missing key`);
    keys.add(q.key);
    if (!subjects.has(q.subject)) errors.push(`${where} unknown subject ${q.subject}`);
    if (!q.key.startsWith(q.subject)) errors.push(`${where} key does not match subject`);
    if (!Array.isArray(q.options) || q.options.length !== 4) errors.push(`${where} needs 4 options`);
    if (new Set(q.options).size !== q.options.length) errors.push(`${where} duplicate options`);
    if (!Number.isInteger(q.correct) || q.correct < 0 || q.correct >= q.options.length) errors.push(`${where} bad correct index`);
    if (!q.question || !q.explanation) errors.push(`${where} missing question/explanation`);
    perSubject[q.subject] = (perSubject[q.subject] || 0) + 1;
  }
}
console.log(Object.entries(perSubject).map(([s, n]) => `${s}:${n}`).join('  '));
console.log(`${keys.size} questions`);
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
