// @ts-check
/**
 * Scenario B on the PROVIDED schema (schema/sample-survey-schema.json = the original file with its
 * one missing comma added). The form renders each of its 3 surveys at runtime.
 */
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { fromBuilderFormat } = require('../../web/builder-format');
const { SurveyPage } = require('./survey-page');

const FILE = 'sample-survey-schema.json';
const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '../../schema', FILE), 'utf8'));

test.describe('B1 on the real schema: "Do you have a hobby?" (Survey 3 - Student Interests & Hobbies)', () => {
  let survey;
  test.beforeEach(async ({ page }) => {
    survey = new SurveyPage(page);
    await survey.open(FILE, 3);
  });

  test('"What is your hobby?" becomes visible when "Do you have a hobby?" = Yes', async ({ page }) => {
    const hobby = page.getByLabel('What is your hobby? (If Yes)');
    await expect(hobby).toBeHidden();

    await page.getByLabel('Do you have a hobby?').selectOption('Yes');
    await expect(hobby).toBeVisible();
    await expect(hobby).toBeEditable();
  });

  test('stays hidden for "No", and hides + clears again when switching Yes -> No -> Yes', async ({ page }) => {
    const hasHobby = page.getByLabel('Do you have a hobby?');
    const hobby = page.getByLabel('What is your hobby? (If Yes)');
    await hasHobby.selectOption('No');
    await expect(hobby).toBeHidden();

    await hasHobby.selectOption('Yes');
    await hobby.fill('Drawing');
    await hasHobby.selectOption('No');
    await expect(hobby).toBeHidden();
    await hasHobby.selectOption('Yes');
    await expect(hobby).toHaveValue('');
  });

  test('hidden hobby answer is not submitted', async ({ page }) => {
    await page.getByLabel('What is your favorite subject at school?').selectOption('Math');
    await page.getByLabel('Do you have a hobby?').selectOption('Yes');
    await page.getByLabel('What is your hobby? (If Yes)').fill('Drawing');
    await page.getByLabel('Do you have a hobby?').selectOption('No');
    await page.getByLabel('How do you like to learn?').selectOption('By Doing');
    await page.getByLabel('Would you like extra activities after school?').selectOption('No');
    await survey.submit();
    const data = await survey.submittedData();
    expect(data.answers).toEqual({ q_1: 'Math', q_3: 'No', q_5: 'By Doing', q_6: 'No' });
  });

  test('required dropdowns block submission until answered', async () => {
    await survey.submit();
    for (const id of ['q_1', 'q_3', 'q_5', 'q_6']) await expect(survey.error(id)).toHaveText('This answer is required');
    await expect(survey.page.getByTestId('submission')).toBeHidden();
  });

  test('sections and hint texts from the schema are shown', async ({ page }) => {
    for (const title of ['Favorite Things', 'Hobbies', 'Learning Preferences']) {
      await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    }
    await expect(survey.question('q_3')).toContainText('Yes or No.');
  });
});

// ---------- Generated: every skip rule in all 3 surveys ----------
doc.surveys.forEach((_, i) => {
  const schema = fromBuilderFormat(doc, i);
  const byId = Object.fromEntries(schema.questions.map(q => [q.id, q]));
  const rules = schema.questions.filter(q => q.visible_if);

  test.describe(`Generated: survey ${i + 1} "${schema.title}" (${rules.length} skip rules)`, () => {
    for (const q of rules) {
      const c = q.visible_if;
      const target = byId[c.question];
      const other = target.options.find(o => o.value !== c.value).value;

      test(`${q.id} "${q.label}" shown when ${c.question} = ${c.value}, hidden when ${c.question} = ${other}`, async ({ page }) => {
        const s = new SurveyPage(page);
        await s.open(FILE, i + 1);
        await expect(s.question(q.id)).toBeHidden();
        await s.answer(c.question, target.type, c.value);
        await expect(s.question(q.id)).toBeVisible();
        await s.answer(c.question, target.type, other);
        await expect(s.question(q.id)).toBeHidden();
      });
    }
  });
});

test.describe('Robustness against the original (broken) file', () => {
  test('the original file with the JSON error shows a clear message, not a blank or half-built form', async ({ page }) => {
    await page.goto('/?schema=' + encodeURIComponent('provided/3.Sample_Survey_Schema.json'));
    await expect(page.locator('body[data-ready="error"]')).toBeAttached();
    await expect(page.getByTestId('load-error')).toContainText('The form definition is invalid');
    await expect(page.getByTestId('submit')).toBeHidden();
    await expect(page.locator('.question')).toHaveCount(0);
  });
});

test.describe('Known schema bug PS-03 seen from the user side', () => {
  test('the sleep HFC never re-asks: q_3 (hours) only appears when q_2 = No, but the rule needs q_2 = Yes', async ({ page }) => {
    const s = new SurveyPage(page);
    await s.open(FILE, 2);
    await page.getByLabel('How do you feel today?').selectOption('Tired');
    await page.getByLabel('Did you sleep well last night?').selectOption('Yes');
    await expect(s.question('q_3')).toBeHidden();             // the hours question can't even be answered
    await page.getByLabel('Did you sleep well last night?').selectOption('No');
    await page.getByLabel('How many hours did you sleep? (If No)').fill('3');
    await page.getByLabel('Did you eat breakfast today?').selectOption('Yes');
    await page.getByLabel('Do you want to talk to a teacher about any worry?').selectOption('No');
    await s.submit();
    await expect(page.getByTestId('hfc-alert')).toBeHidden();  // no re-ask in any combination
    const data = await s.submittedData();
    expect(data.hfc_flags).toEqual([]);
  });
});
