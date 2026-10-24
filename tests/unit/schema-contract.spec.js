// @ts-check
/**
 * Scenario B - schema contract tests.
 * The builder (web) produces JSON; the Android app renders it. A broken schema is the most
 * common way a builder release breaks forms on the phone. These checks run in milliseconds
 * on every builder build, BEFORE any UI test, and fail fast with a readable reason.
 *
 * Each "mutation" below is a realistic builder bug; the contract must catch every one.
 */
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { validateSchema } = require('../../web/logic');

const SCHEMA_DIR = path.join(__dirname, '../../schema');
const load = f => JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, f), 'utf8'));
const clone = o => JSON.parse(JSON.stringify(o));

test.describe('Schema contract', () => {
  // engine-format schemas only (the builder-format file is audited in provided-schema-audit.spec.js)
  for (const file of fs.readdirSync(SCHEMA_DIR).filter(f => f.endsWith('.json') && !load(f).surveys)) {
    test(`${file} passes the contract`, () => {
      expect(validateSchema(load(file))).toEqual([]);
    });
  }

  const base = load('household-survey.schema.json');
  const find = (s, id) => s.questions.find(q => q.id === id);
  const mutations = [
    { bug: 'duplicate question id', expect: 'duplicate id', apply: s => { find(s, 'college_name').id = 'age'; } },
    { bug: 'skip rule points to a deleted question', expect: 'not an earlier question', apply: s => { s.questions = s.questions.filter(q => q.id !== 'has_hobby'); } },
    { bug: 'skip rule points to a LATER question (forward reference)', expect: 'not an earlier question', apply: s => { find(s, 'hobby_name').visible_if = { question: 'age', op: 'gt', value: 5 }; } },
    { bug: 'new operator the app does not know', expect: 'unknown operator', apply: s => { find(s, 'hobby_name').visible_if.op = 'regex'; } },
    { bug: 'new question type the app cannot render', expect: 'unknown type', apply: s => { s.questions.push({ id: 'sig', type: 'signature', label: 'Sign' }); } },
    { bug: 'select question with no options', expect: 'no options', apply: s => { find(s, 'education').options = []; } },
    { bug: 'duplicate option values', expect: 'duplicate option values', apply: s => { find(s, 'education').options.push({ value: 'none', label: 'None again' }); } },
    { bug: 'min greater than max', expect: 'min > max', apply: s => { find(s, 'age').min = 200; } },
    { bug: 'roster count from unknown question', expect: 'repeat_count', apply: s => { find(s, 'members').repeat_count = 'family_size'; } },
    { bug: 'empty roster', expect: 'repeat has no questions', apply: s => { find(s, 'members').questions = []; } },
    { bug: 'HFC rule references renamed question', expect: 'unknown question', apply: s => { s.hfc_rules[0].when.all[0].question = 'respondent_age'; } },
    { bug: 'HFC rule with unknown action', expect: 'unknown action', apply: s => { s.hfc_rules[0].action = 'reask_forever'; } },
    { bug: 'question without a label', expect: 'missing label', apply: s => { delete find(s, 'age').label; } },
  ];
  for (const m of mutations) {
    test(`catches builder bug: ${m.bug}`, () => {
      const s = clone(base);
      m.apply(s);
      const errors = validateSchema(s);
      expect(errors.join('\n')).toContain(m.expect);
    });
  }
});
