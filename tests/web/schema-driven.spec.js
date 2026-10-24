// @ts-check
/**
 * Scenario B - regression suite GENERATED from the schema.
 *
 * Instead of hand-writing one test per question, this file reads the schema and creates
 * two tests for every top-level skip-logic rule (rules inside rosters are covered by the
 * hand-written roster tests in skip-logic.spec.js): "rule satisfied -> question shown" and
 * "rule not satisfied -> question hidden". When the builder adds a question or a rule,
 * the suite grows automatically - nobody has to remember to write the test.
 *
 * Point it at another schema:   SCHEMA=my-survey.json npx playwright test --project=web
 */
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { collectRefs } = require('../../web/logic');
const { SurveyPage } = require('./survey-page');

const SCHEMA_FILE = process.env.SCHEMA || 'household-survey.schema.json';
const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '../../schema', SCHEMA_FILE), 'utf8'));
const byId = Object.fromEntries(schema.questions.map(q => [q.id, q]));

/** A value that makes one simple condition TRUE / FALSE for the controlling question. */
function valueFor(cond, wantTrue) {
  const q = byId[cond.question];
  const other = q.options ? (q.options.find(o => o.value !== cond.value) || {}).value : 'zzz';
  const v = cond.value;
  switch (cond.op) {
    case 'eq': return wantTrue ? v : other;
    case 'neq': return wantTrue ? other : v;
    case 'lt': return wantTrue ? v - 1 : v;          // boundary values
    case 'lte': return wantTrue ? v : v + 1;
    case 'gt': return wantTrue ? v + 1 : v;
    case 'gte': return wantTrue ? v : v - 1;
    case 'contains': return wantTrue ? [v] : [q.options.find(o => o.value !== v).value];
    case 'not_empty': return wantTrue ? 'some value' : '';
    case 'empty': return wantTrue ? '' : 'some value';
    case 'in': return wantTrue ? v[0] : other;
    default: throw new Error(`no generator for op ${cond.op}`);
  }
}

/** Steps that make a question visible, including its parents' conditions (chains). */
function stepsToShow(qid, steps = []) {
  const q = byId[qid];
  for (const c of collectRefs(q.visible_if)) {
    stepsToShow(c.question, steps);
    steps.push([c.question, valueFor(c, true)]);
  }
  return steps;
}

const rules = schema.questions.filter(q => q.visible_if && q.type !== 'repeat');

test.describe(`Generated skip-logic tests for ${schema.survey_id} (${rules.length} rules)`, () => {
  for (const q of rules) {
    const conds = collectRefs(q.visible_if);

    test(`"${q.label}" is SHOWN when ${conds.map(c => `${c.question} ${c.op} ${c.value ?? ''}`).join(' AND ')}`, async ({ page }) => {
      const s = new SurveyPage(page);
      await s.open(SCHEMA_FILE);
      for (const [id, val] of stepsToShow(q.id)) await s.answer(id, byId[id].type, val);
      await expect(s.question(q.id)).toBeVisible();
    });

    test(`"${q.label}" is HIDDEN when ${conds[conds.length - 1].question} does not match`, async ({ page }) => {
      const s = new SurveyPage(page);
      await s.open(SCHEMA_FILE);
      const steps = stepsToShow(q.id);
      const last = conds[conds.length - 1];
      // satisfy everything, then break the last condition
      for (const [id, val] of steps) await s.answer(id, byId[id].type, val);
      await s.answer(last.question, byId[last.question].type, valueFor(last, false));
      await expect(s.question(q.id)).toBeHidden();
    });
  }

  test('every question in the schema is rendered exactly once', async ({ page }) => {
    const s = new SurveyPage(page);
    await s.open(SCHEMA_FILE);
    for (const q of schema.questions) await expect(page.locator(`[data-qid="${q.id}"]`)).toHaveCount(1);
  });

  test('questions without skip logic are visible on load', async ({ page }) => {
    const s = new SurveyPage(page);
    await s.open(SCHEMA_FILE);
    for (const q of schema.questions.filter(q => !q.visible_if)) await expect(s.question(q.id)).toBeVisible();
  });
});
