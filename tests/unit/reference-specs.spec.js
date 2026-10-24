// @ts-check
/**
 * Consistency checks between the reference documents (docs/reference/) and the provided schema.
 * Defects in the documents themselves are marked test.fail() with their id in
 * test-cases/provided-schema-defects.csv (PS-21..PS-23).
 */
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { fromBuilderFormat, questionsOf } = require('../../web/builder-format');
const { runHfc } = require('../../web/logic');

const ref = f => fs.readFileSync(path.join(__dirname, '../../docs/reference', f), 'utf8');
const text = html => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '')
  .replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#39;|&rsquo;/g, "'").replace(/\s+/g, ' ');
const android = text(ref('1.Android App Specification.html'));
const builder = text(ref('2.Survey Builder Tool Capabilities.html'));
const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '../../schema/sample-survey-schema.json'), 'utf8'));

/** Extract the JSON object that follows `"formChecks": [` in a spec text. */
function specRule(t) {
  const i = t.indexOf('"formChecks"');
  const start = t.indexOf('{', i), body = t.slice(start);
  let depth = 0, end = 0;
  for (let k = 0; k < body.length; k++) { if (body[k] === '{') depth++; if (body[k] === '}' && --depth === 0) { end = k + 1; break; } }
  return JSON.parse(body.slice(0, end));
}

test.describe('Reference documents vs provided schema', () => {
  const androidRule = specRule(android);
  const schemaRule = questionsOf(doc.surveys[1]).find(q => q.questionId === 'q_3').formChecks[0];

  test('the Android spec HFC example uses the "attr" key (confirms PS-02: the schema\'s "questioID" is wrong)', () => {
    expect(androidRule.logic[0]).toHaveProperty('attr', 'q_3');
    expect(schemaRule.logic[0]).not.toHaveProperty('attr');
  });

  test.fail('[KNOWN BUG PS-21] hfc_sleep_plausible means the same in the Android spec and in the schema', () => {
    expect(androidRule.id).toBe(schemaRule.id);   // same id ...
    expect(schemaRule.logic.map(c => [c.op, c.val])).toEqual(androidRule.logic.map(c => [c.op, c.val])); // ... different rule: "> 16" vs "= Yes AND < 6"
  });

  test('the Android spec example rule runs in the engine: 20 h fires, 16 h does not', () => {
    const schema = fromBuilderFormat({ surveys: [{ surveyData: { title: 't', sections: [{ title: 's', questions: [
      { questionId: 'q_3', inputType: 'Number', questionText: 'Hours', validationRules: { type: 'range', min: '0', max: '24' }, formChecks: [androidRule] },
    ] }] } }] }, 0);
    expect(runHfc(schema, { q_3: 20 }).map(r => r.id)).toEqual(['hfc_sleep_plausible']);
    expect(runHfc(schema, { q_3: 16 })).toEqual([]);
  });

  test('the Android spec only requires "Soft" checks; the provided rule is Soft', () => {
    expect(android).toContain('only need to handle "Soft" severity');
    expect(schemaRule.severity).toBe('Soft');
  });
});

test.describe('Survey Builder Tool Capabilities - document defects', () => {
  test.fail('[KNOWN BUG PS-22] the number of input types stated ("Twenty") matches the table (13 types)', () => {
    const stated = /Twenty input types/.test(builder) ? 20 : null;
    const listed = ['Text', 'TextArea', 'Number', 'Dropdown', 'Radio', 'Checkbox', 'Matrix', 'Date', 'Image', 'Audio', 'GPS', 'Roster', 'Note'];
    for (const t of listed) expect(builder).toContain(t);
    expect(stated).toBe(listed.length);
  });

  test.fail('[KNOWN BUG PS-23] the HFC example in §11 has a valid operator', () => {
    const rule = specRule(builder);
    expect(['=', '!=', '>', '>=', '<', '<=', 'contains', 'in', 'empty', 'not_empty']).toContain(rule.logic[0].op); // it is " "
  });

  test('§11 documents the four actions used by the engine', () => {
    for (const a of ['flag_silently', 'reask_once', 'reask_and_flag', 'block']) expect(builder).toContain(a);
  });
});
