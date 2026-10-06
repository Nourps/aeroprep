import Anthropic from '@anthropic-ai/sdk';
import { db, getSetting } from '../db.js';
import { config } from '../config.js';
import { searchChunks, pageText } from './pdf.js';

// Models that accept the server-side refusal fallback ("default" routing).
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);
const MAX_TOOL_ROUNDS = 6;

let cached = { key: null, client: null };
export function apiKey() {
  return config.anthropicApiKey || getSetting('ai_api_key') || '';
}
function client() {
  const key = apiKey();
  if (!key) throw Object.assign(new Error('AI is not configured'), { code: 'ai_not_configured' });
  if (cached.key !== key) cached = { key, client: new Anthropic({ apiKey: key }) };
  return cached.client;
}

/** Sends a request, adding the refusal fallback when the selected model supports it. */
export async function send(params) {
  const model = getSetting('ai_model');
  const body = {
    model,
    max_tokens: 16000,
    ...params,
    output_config: { effort: getSetting('ai_effort'), ...(params.output_config || {}) },
  };
  if (FALLBACK_MODELS.has(model)) {
    return client().beta.messages.create({ ...body, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  }
  return client().messages.create(body);
}

export function addUsage(total, usage) {
  if (!usage) return;
  total.input += (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  total.output += usage.output_tokens || 0;
  total.searches = (total.searches || 0) + (usage.server_tool_use?.web_search_requests || 0);
}

export function logUsage(userId, kind, model, usage, question) {
  db.prepare('INSERT INTO ai_usage (user_id, kind, model, input_tokens, output_tokens, web_searches, question) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(userId, kind, model, usage.input, usage.output, usage.searches || 0, String(question).slice(0, 500));
}

// ---------------------------------------------------------------------------
// Document Q&A: Claude searches the indexed PDFs itself through two tools.
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: 'search_documents',
    description: 'Full-text search over the A320 document library (FCOM, FCTM, QRH, MEL, type-rating notes...). '
      + 'Documents are mostly in English: search with English technical terms and Airbus abbreviations '
      + '(e.g. "PTU", "BLUE ELEC PUMP", "ALTN LAW", "X BLEED"). Returns the best matching passages with document id and page.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords to search for.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_page',
    description: 'Returns the full extracted text of one page of a document, to read the context around a search hit.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        doc_id: { type: 'integer' },
        page: { type: 'integer' },
      },
      required: ['doc_id', 'page'],
      additionalProperties: false,
    },
  },
];

const SYSTEM = `You are the study assistant of AeroPrep, helping airline pilots revise the Airbus A320 family.
Answer ONLY from the documents of the library, which you reach with the search_documents and read_page tools.
Search several times with different English keywords if needed, and read the relevant pages before answering.

Rules:
- Cite every fact with a marker of the form [doc:ID p.PAGE] (e.g. [doc:3 p.112]) right after the sentence it supports.
- If the documents do not contain the answer, say so plainly; do not fill gaps from general knowledge without labelling it as such.
- Answer in the language of the question (French or English). Keep Airbus terms, ECAM wording and abbreviations in English.
- Be precise and structured, like a type-rating instructor: short paragraphs or bullet points, values with units.
- This is a revision tool: remind the user, only when relevant to a procedure, that the company's current approved documentation prevails.`;

async function runTool(name, input) {
  if (name === 'search_documents') {
    const hits = searchChunks(String(input.query || ''), { limit: 8 });
    if (!hits.length) return 'No result. Try other keywords (English, Airbus abbreviations).';
    return hits.map((h) => `--- [doc:${h.doc_id} p.${h.page}] ${h.title} (${h.category})\n${h.text.slice(0, 1500)}`).join('\n\n');
  }
  if (name === 'read_page') {
    const doc = db.prepare('SELECT title FROM documents WHERE id = ?').get(Number(input.doc_id));
    if (!doc) return 'Unknown document id.';
    const text = pageText(Number(input.doc_id), Number(input.page));
    return text ? `[doc:${input.doc_id} p.${input.page}] ${doc.title}\n${text}` : 'Empty or unknown page.';
  }
  return `Unknown tool ${name}`;
}

/**
 * @param {object} user
 * @param {string} question
 * @param {{q: string, a: string}[]} history previous exchanges of the same chat (plain text)
 */
export async function askDocuments(user, question, history = []) {
  const model = getSetting('ai_model');
  const usage = { input: 0, output: 0 };
  const messages = [];
  for (const h of history.slice(-4)) {
    messages.push({ role: 'user', content: String(h.q).slice(0, 4000) });
    messages.push({ role: 'assistant', content: String(h.a).slice(0, 8000) });
  }
  messages.push({ role: 'user', content: question });

  const sources = new Map();
  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const lastRound = round === MAX_TOOL_ROUNDS;
      const response = await send({
        system: SYSTEM,
        tools: TOOLS,
        ...(lastRound ? { tool_choice: { type: 'none' } } : {}),
        messages,
      });
      addUsage(usage, response.usage);

      if (response.stop_reason === 'refusal') {
        return { answer: null, error: 'refusal', sources: [] };
      }
      // Keep the full content (thinking blocks included) so the next turn stays valid.
      messages.push({ role: 'assistant', content: response.content });

      const toolUses = response.content.filter((b) => b.type === 'tool_use');
      if (response.stop_reason !== 'tool_use' || !toolUses.length) {
        const answer = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
        for (const m of answer.matchAll(/\[doc:(\d+) p\.(\d+)\]/g)) sources.set(`${m[1]}:${m[2]}`, { docId: Number(m[1]), page: Number(m[2]) });
        const titles = new Map(db.prepare('SELECT id, title FROM documents').all().map((d) => [d.id, d.title]));
        return {
          answer,
          truncated: response.stop_reason === 'max_tokens',
          sources: [...sources.values()].filter((s) => titles.has(s.docId)).map((s) => ({ ...s, title: titles.get(s.docId) })),
        };
      }
      const results = [];
      for (const tu of toolUses) {
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: await runTool(tu.name, tu.input || {}) });
      }
      messages.push({ role: 'user', content: results });
    }
    return { answer: null, error: 'no_answer', sources: [] };
  } finally {
    logUsage(user.id, 'ask', model, usage, question);
  }
}

// ---------------------------------------------------------------------------
// Question generation from a document (admin): result is stored inactive for review.
// ---------------------------------------------------------------------------
const GEN_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          topic: { type: 'string' },
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          correct: { type: 'integer' },
          explanation: { type: 'string' },
          page: { type: 'integer' },
          difficulty: { type: 'integer' },
        },
        required: ['topic', 'question', 'options', 'correct', 'explanation', 'page', 'difficulty'],
        additionalProperties: false,
      },
    },
  },
  required: ['questions'],
  additionalProperties: false,
};

export async function generateQuestions(user, { docId, fromPage, toPage, count, subject }) {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(docId);
  if (!doc) throw Object.assign(new Error('Unknown document'), { code: 'not_found' });
  const pages = db.prepare('SELECT page, text FROM doc_chunks WHERE doc_id = ? AND page BETWEEN ? AND ? ORDER BY page, rowid')
    .all(docId, fromPage, toPage);
  let material = '';
  for (const p of pages) {
    const piece = `\n[page ${p.page}]\n${p.text}`;
    if (material.length + piece.length > 120_000) break;
    material += piece;
  }
  if (!material.trim()) throw Object.assign(new Error('No text on these pages'), { code: 'no_text' });

  const model = getSetting('ai_model');
  const usage = { input: 0, output: 0 };
  try {
    const response = await send({
      output_config: { format: { type: 'json_schema', schema: GEN_SCHEMA } },
      system: 'You write multiple-choice revision questions for A320 type-rated airline pilots, at the level of a type-rating or line-check oral. '
        + 'Each question has exactly 4 options, one correct (index 0-3), plausible distractors, and an explanation citing the system logic. '
        + 'Base every question strictly on the provided extract; set "page" to the page that supports the answer. Difficulty: 1 easy, 2 medium, 3 hard. Write in English.',
      messages: [{
        role: 'user',
        content: `Document: ${doc.title} (${doc.category}), pages ${fromPage}-${toPage}.\nWrite ${count} questions.\n<extract>${material}\n</extract>`,
      }],
    });
    addUsage(usage, response.usage);
    if (response.stop_reason === 'refusal') throw Object.assign(new Error('Refused'), { code: 'refusal' });
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const parsed = JSON.parse(text);
    const insert = db.prepare(`INSERT INTO questions (space, subject_code, topic, question, options, correct, explanation, difficulty, source, reference, active, created_by)
      VALUES ('a320', ?, ?, ?, ?, ?, ?, ?, 'ai', ?, 0, ?)`);
    let added = 0;
    for (const q of parsed.questions || []) {
      if (!Array.isArray(q.options) || q.options.length !== 4 || !(q.correct >= 0 && q.correct <= 3)) continue;
      insert.run(subject, q.topic, q.question, JSON.stringify(q.options), q.correct, q.explanation,
        Math.min(3, Math.max(1, q.difficulty || 2)), `${doc.title} p.${q.page}`, user.id);
      added++;
    }
    return { added };
  } finally {
    logUsage(user.id, 'generate', model, usage, `generate ${doc.title} p.${fromPage}-${toPage}`);
  }
}

export function aiStatus() {
  return { configured: !!apiKey(), keyFromEnv: !!config.anthropicApiKey, model: getSetting('ai_model'), effort: getSetting('ai_effort') };
}
