import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, detectMinHours, extractJsonLdJobs, isPilotJob } from '../server/services/jobs.js';

test('cadet programmes are classified as cadet without type rating', () => {
  const c = classify({ title: 'Cadet Pilot Programme 2027', description: 'Ab initio training to MPL on the A320 family.' });
  assert.equal(c.category, 'cadet');
  assert.equal(c.typeRating, 'not_required');
  assert.match(c.aircraft, /a320/);
});

test('type-rated first officer with hours requirement', () => {
  const c = classify({ title: 'Type Rated First Officer B737', description: 'Valid B737 type rating. Minimum 1,500 hours total time, 500 hours on type.' });
  assert.equal(c.category, 'type_rated');
  assert.equal(c.typeRating, 'required');
  assert.equal(c.minHours, 1500);
  assert.equal(c.aircraft, 'b737');
});

test('non type rated low hours offer', () => {
  const c = classify({ title: 'First Officer - Non Type Rated', description: 'fATPL holders, type rating provided. Min 200 hrs.' });
  assert.equal(c.category, 'low_hours');
  assert.equal(c.typeRating, 'not_required');
  assert.equal(c.minHours, 200);
});

test('captain implies type rating required', () => {
  const c = classify({ title: 'Commandant de bord A330', description: 'Expérience de 5000 heures' });
  assert.equal(c.category, 'captain');
  assert.equal(c.typeRating, 'required');
  assert.equal(c.aircraft, 'a330_350');
  assert.equal(c.minHours, 5000);
});

test('hours detection ignores small numbers', () => {
  assert.equal(detectMinHours('Duty of 12 hours'), null);
  assert.equal(detectMinHours('3 000 h de vol dont 1000h PIC'), 3000);
});

test('pilot filter', () => {
  assert.ok(isPilotJob('A320 Captain'));
  assert.ok(!isPilotJob('Aircraft Maintenance Engineer B1'));
});

test('JSON-LD JobPosting extraction', () => {
  const html = `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"JobPosting","title":"Pilot &amp; FO","url":"https://x.test/j/1","datePosted":"2026-09-01","description":"<p>A320 type rating</p>","hiringOrganization":{"name":"Air Test"},"jobLocation":{"address":{"addressLocality":"Paris","addressCountry":"FR"}}}]}</script>`;
  const [j] = extractJsonLdJobs(html, 'https://x.test');
  assert.equal(j.title, 'Pilot & FO');
  assert.equal(j.company, 'Air Test');
  assert.equal(j.location, 'Paris, FR');
  assert.equal(j.postedAt, '2026-09-01');
  assert.equal(j.description, 'A320 type rating');
});
