// @ts-check
/**
 * Audit of the PROVIDED schema: schema/provided/3.Sample_Survey_Schema.json (kept byte-for-byte).
 *
 * Every contract rule is a test. Rules the provided file currently breaks are marked with
 * test.fail() and a bug id from test-cases/provided-schema-defects.csv:
 *   - today they show as "expected failure" (green), documenting the known bug;
 *   - when the builder team fixes the bug, the test starts PASSING, Playwright reports it as
 *     "expected to fail but passed" (red) - a reminder to remove the annotation.
 * So the suite tracks the bugs without hiding them and without breaking CI.
 */
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { auditBuilderSchema, fromBuilderFormat, questionsOf } = require('../../web/builder-format');
const { validateSchema } = require('../../web/logic');

const ORIGINAL = path.join(__dirname, '../../schema/provided/3.Sample_Survey_Schema.json');
const FIXED = path.join(__dirname, '../../schema/sample-survey-schema.json'); // only the missing comma added
const raw = fs.readFileSync(ORIGINAL, 'utf8');
const doc = JSON.parse(fs.readFileSync(FIXED, 'utf8'));
const findings = auditBuilderSchema(doc);
const codes = new Set(findings.map(f => f.code));

// Contract rule -> known bug id (if the provided file currently breaks it)
const KNOWN_BUGS = {
  HFC_BAD_KEY: 'PS-02',
  HFC_UNREACHABLE: 'PS-03',
  NO_SURVEY_ID: 'PS-04',
  NO_SCHEMA_VERSION: 'PS-05',
  NUMBER_AS_STRING: 'PS-06',
  VALIDATION_RULES_MIXED_TYPES: 'PS-07',
  HINT_KEY_INCONSISTENT: 'PS-08',
  OTHER_WITHOUT_SPECIFY: 'PS-09',
  NO_LANGUAGE: 'PS-19',
  SCHEMA_VS_BUILDER_MODEL: 'PS-20',
};

const RULES = [
  ['NO_QUESTION_ID', 'every question has a questionId'],
  ['DUPLICATE_QUESTION_ID', 'questionIds are unique within a survey'],
  ['UNKNOWN_INPUT_TYPE', 'every inputType is supported by the app'],
  ['DROPDOWN_NO_OPTIONS', 'every dropdown has options'],
  ['DUPLICATE_OPTION', 'dropdown options are unique'],
  ['VIS_TARGET_INVALID', 'visibility logic only targets an earlier question'],
  ['VIS_VALUE_NOT_AN_OPTION', 'visibility value is one of the target question\'s options'],
  ['VIS_UNKNOWN_CONDITION', 'visibility condition is a known operator'],
  ['HFC_UNKNOWN_ACTION', 'HFC action is one of the Builder actions (flag_silently, reask_once, reask_and_flag, block)'],
  ['HFC_UNKNOWN_SEVERITY', 'HFC severity is one of Critical, Hard, Soft, Observation'],
  ['HFC_UNKNOWN_QUESTION', 'HFC rules reference existing questions'],
  ['HFC_UNKNOWN_OP', 'HFC operators are known'],
  ['HFC_BAD_KEY', 'HFC conditions use the "attr" key (Builder spec §11, Android spec §3)'],
  ['HFC_UNREACHABLE', 'every HFC rule can actually fire (not contradicted by visibility logic)'],
  ['NO_SURVEY_ID', 'every survey has an id'],
  ['NO_SCHEMA_VERSION', 'every survey has a schema version'],
  ['NUMBER_AS_STRING', 'numeric limits and comparisons use numbers, not strings'],
  ['VALIDATION_RULES_MIXED_TYPES', 'validationRules always has the same shape'],
  ['HINT_KEY_INCONSISTENT', 'hints always use the same key (hintText)'],
  ['NO_LANGUAGE', 'every survey states its language (Builder model §2)'],
  ['SCHEMA_VS_BUILDER_MODEL', 'the schema uses the field names/shapes of the Builder model (items, checklistGuide[], hintText[], validations[])'],
  ['OTHER_WITHOUT_SPECIFY', 'an "Other" option has a follow-up "specify" question'],
];

test.describe('Provided schema - file level', () => {
  test.fail('[KNOWN BUG PS-01] the provided file is valid JSON (missing comma in formChecks.logic, line 158)', () => {
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  test('the fixed copy differs from the original ONLY by that one comma', () => {
    const fixed = fs.readFileSync(FIXED, 'utf8');
    expect(fixed.length - raw.length).toBe(1);
    expect(fixed.replace('"val": "Yes" },', '"val": "Yes" }')).toBe(raw);
  });

  test('contains 3 surveys, each converts into a valid form definition', () => {
    expect(doc.surveys).toHaveLength(3);
    doc.surveys.forEach((_, i) => expect(validateSchema(fromBuilderFormat(doc, i)), `survey ${i + 1}`).toEqual([]));
  });

  test('every skip rule in the provided schema is accounted for (8 rules)', () => {
    const rules = doc.surveys.flatMap(s => questionsOf(s).filter(q => q.visibilityLogic && q.visibilityLogic.enabled));
    expect(rules).toHaveLength(8);
  });
});

test.describe('Provided schema - contract rules', () => {
  for (const [code, rule] of RULES) {
    const bug = KNOWN_BUGS[code];
    const title = bug ? `[KNOWN BUG ${bug}] ${rule}` : rule;
    const body = () => {
      const hits = findings.filter(f => f.code === code);
      expect(hits.map(f => `${f.path}: ${f.message}`), rule).toEqual([]);
    };
    if (bug) test.fail(title, body); else test(title, body);
  }

  test('no undocumented findings: every error/warning found is a known, logged bug', () => {
    const unknown = findings.filter(f => f.severity !== 'info' && !KNOWN_BUGS[f.code]);
    expect(unknown).toEqual([]);
  });

  test('the strict loader refuses the broken HFC rule instead of evaluating it on an undefined question', () => {
    const survey2 = fromBuilderFormat(doc, 1);
    expect(survey2.hfc_rules).toEqual([]); // rule skipped because its conditions use "questioID"
    expect(codes.has('HFC_BAD_KEY')).toBe(true);
  });
});
