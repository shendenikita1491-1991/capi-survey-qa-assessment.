// @ts-check
/**
 * Scenario E - HFC engine, data-driven from test-cases/hfc-engine-test-plan.csv.
 * The documented test plan IS the test data, so the plan and the automation never drift apart.
 */
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { runHfc } = require('../../web/logic');

const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '../../schema/household-survey.schema.json'), 'utf8'));

// Simple CSV reader: the plan's cells contain no commas or quotes (kept that way on purpose)
function readCsv(file) {
  const [header, ...lines] = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
  const cols = header.split(',');
  return lines.map(line => {
    const cells = line.split(',');
    return Object.fromEntries(cols.map((c, i) => [c, (cells[i] || '').trim()]));
  });
}
const rows = readCsv(path.join(__dirname, '../../test-cases/hfc-engine-test-plan.csv'));

test.describe('HFC engine rules (from the CSV test plan)', () => {
  for (const row of rows) {
    test(`${row.id} [${row.category}] ${row.scenario}`, () => {
      const answers = {};
      if (row.age !== '') answers.age = row.age_value_type === 'string' ? row.age : Number(row.age);
      if (row.education) answers.education = row.education;
      if (row.sleep_well) answers.sleep_well = row.sleep_well;
      if (row.sleep_hours !== '') answers.sleep_hours = Number(row.sleep_hours);

      const fired = runHfc(schema, answers).map(r => r.id).sort();
      const expected = row.expected_rules ? row.expected_rules.split('|').sort() : [];
      expect(fired).toEqual(expected);
    });
  }

  test('every HFC rule in the schema is covered by at least one positive case in the plan', () => {
    const covered = new Set(rows.flatMap(r => (r.expected_rules ? r.expected_rules.split('|') : [])));
    for (const rule of schema.hfc_rules) expect(covered, `rule ${rule.id} has no test`).toContain(rule.id);
  });

  test('every rule offers a way out (reask_and_flag, never a hard block) so the user cannot get stuck', () => {
    for (const rule of schema.hfc_rules) expect(rule.action).toBe('reask_and_flag');
  });
});
