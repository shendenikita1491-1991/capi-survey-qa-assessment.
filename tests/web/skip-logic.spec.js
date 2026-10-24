// @ts-check
/**
 * Scenario B - dynamic skip logic on the schema-driven web form.
 * The form is rendered at runtime from schema/household-survey.schema.json.
 */
const { test, expect } = require('@playwright/test');
const { SurveyPage } = require('./survey-page');

let survey;
test.beforeEach(async ({ page }) => {
  survey = new SurveyPage(page);
  await survey.open();
});

test.describe('B1. "Do you have a hobby?" skip rule (the example from the brief)', () => {
  test('"What is your hobby?" is hidden until "Yes" is chosen, then becomes visible', async ({ page }) => {
    const hobbyQuestion = page.getByLabel('What is your hobby?');
    await expect(hobbyQuestion).toBeHidden();                    // nothing answered yet

    await page.getByRole('group', { name: /Do you have a hobby\?/ })
      .getByLabel('Yes', { exact: true }).check();                // Do you have a hobby? = Yes
    await expect(hobbyQuestion).toBeVisible();
    await expect(hobbyQuestion).toBeEditable();
  });

  test('choosing "No" keeps it hidden', async ({ page }) => {
    await survey.answer('has_hobby', 'select_one', 'no');
    await expect(survey.question('hobby_name')).toBeHidden();
  });

  test('switching Yes -> No hides it again AND clears the typed answer', async () => {
    await survey.answer('has_hobby', 'select_one', 'yes');
    await survey.answer('hobby_name', 'text', 'Cricket');
    await survey.answer('has_hobby', 'select_one', 'no');
    await expect(survey.question('hobby_name')).toBeHidden();

    await survey.answer('has_hobby', 'select_one', 'yes');   // comes back empty, not with stale data
    await expect(survey.page.locator('#in-hobby_name')).toHaveValue('');
  });

  test('hidden answer is NOT submitted', async () => {
    await fillMinimumValidForm(survey);
    await survey.answer('has_hobby', 'select_one', 'yes');
    await survey.answer('hobby_name', 'text', 'Cricket');
    await survey.answer('has_hobby', 'select_one', 'no');
    await survey.submit();
    const data = await survey.submittedData();
    expect(data.answers.has_hobby).toBe('no');
    expect(data.answers).not.toHaveProperty('hobby_name');
  });

  test('a hidden REQUIRED question does not block submission', async () => {
    await fillMinimumValidForm(survey);            // has_hobby = no -> hobby_name (required) is hidden
    await survey.submit();
    await survey.submittedData();
    await expect(survey.error('hobby_name')).toBeHidden();
  });

  test('a visible REQUIRED question does block submission', async () => {
    await fillMinimumValidForm(survey);
    await survey.answer('has_hobby', 'select_one', 'yes');
    await survey.submit();
    await expect(survey.error('hobby_name')).toHaveText('This answer is required');
    await expect(survey.page.getByTestId('submission')).toBeHidden();
  });
});

test.describe('B2. Chained, numeric and multi-select conditions', () => {
  test('chained rule: hours-per-week needs hobby=Yes AND a hobby name; clearing the parent hides the whole chain', async () => {
    await survey.answer('has_hobby', 'select_one', 'yes');
    await expect(survey.question('hobby_hours')).toBeHidden();
    await survey.answer('hobby_name', 'text', 'Music');
    await expect(survey.question('hobby_hours')).toBeVisible();
    await survey.answer('hobby_hours', 'integer', 5);

    await survey.answer('has_hobby', 'select_one', 'no');      // cascade: hobby_name cleared -> hobby_hours hidden + cleared
    await expect(survey.question('hobby_name')).toBeHidden();
    await expect(survey.question('hobby_hours')).toBeHidden();
    await survey.answer('has_hobby', 'select_one', 'yes');
    await survey.answer('hobby_name', 'text', 'Music');
    await expect(survey.page.locator('#in-hobby_hours')).toHaveValue('');
  });

  for (const [age, visible] of [[17, false], [18, true], [19, true], [0, false]]) {
    test(`boundary: age ${age} -> "employed?" ${visible ? 'shown' : 'hidden'} (rule: age >= 18)`, async () => {
      await survey.answer('age', 'integer', age);
      if (visible) await expect(survey.question('is_employed')).toBeVisible();
      else await expect(survey.question('is_employed')).toBeHidden();
    });
  }

  test('multi-select: "Other" ticked -> "specify" appears; unticked -> disappears', async () => {
    await survey.answer('income_sources', 'select_multiple', ['farming']);
    await expect(survey.question('income_other')).toBeHidden();
    await survey.answer('income_sources', 'select_multiple', ['farming', 'other']);
    await expect(survey.question('income_other')).toBeVisible();
    await survey.answer('income_sources', 'select_multiple', ['farming']);
    await expect(survey.question('income_other')).toBeHidden();
  });
});

test.describe('B3. Repeating roster (questions per household member)', () => {
  test('household size creates one block per member, with skip logic scoped to each member', async () => {
    await survey.answer('household_size', 'integer', 3);
    for (const n of [1, 2, 3]) await expect(survey.page.getByTestId(`members-${n}`)).toBeVisible();
    await expect(survey.page.getByTestId('members-4')).toHaveCount(0);

    await survey.answer('members-1-member_age', 'integer', 40);   // adult
    await survey.answer('members-2-member_age', 'integer', 10);   // child
    await expect(survey.question('members-1-member_in_school')).toBeHidden();
    await expect(survey.question('members-2-member_in_school')).toBeVisible();
    await expect(survey.question('members-3-member_in_school')).toBeHidden(); // age not answered yet
  });

  test('reducing household size removes the extra member and their answers', async () => {
    await survey.answer('household_size', 'integer', 3);
    await survey.answer('members-3-member_name', 'text', 'Third Person');
    await survey.answer('household_size', 'integer', 2);
    await expect(survey.page.getByTestId('members-3')).toHaveCount(0);
    await survey.answer('household_size', 'integer', 3);
    await expect(survey.page.locator('#in-members-3-member_name')).toHaveValue('');
  });

  test('existing members keep their answers when another member is added', async () => {
    await survey.answer('household_size', 'integer', 1);
    await survey.answer('members-1-member_name', 'text', 'Asha');
    await survey.answer('household_size', 'integer', 2);
    await expect(survey.page.locator('#in-members-1-member_name')).toHaveValue('Asha');
  });

  test('roster data is submitted per member, without hidden fields', async () => {
    await fillMinimumValidForm(survey, { household_size: 2 });
    await survey.answer('members-1-member_name', 'text', 'Asha');
    await survey.answer('members-1-member_age', 'integer', 35);
    await survey.answer('members-2-member_name', 'text', 'Ravi');
    await survey.answer('members-2-member_age', 'integer', 8);
    await survey.answer('members-2-member_in_school', 'select_one', 'yes');
    await survey.submit();
    const data = await survey.submittedData();
    expect(data.answers.members).toEqual([
      { member_name: 'Asha', member_age: 35 },
      { member_name: 'Ravi', member_age: 8, member_in_school: 'yes' },
    ]);
  });
});

test.describe('B4. HFC engine in the form (re-ask and flag, never an endless loop)', () => {
  test('Age 12 + College -> re-ask shown; fixing the answer submits with no flag', async () => {
    await fillMinimumValidForm(survey, { age: 12, education: 'college' });
    await survey.submit();
    await expect(survey.page.getByTestId('hfc-HFC_AGE_EDU')).toBeVisible();
    await expect(survey.page.getByTestId('submission')).toBeHidden();

    await survey.page.getByTestId('hfc-change').click();
    await survey.answer('education', 'select_one', 'primary');
    await survey.submit();
    const data = await survey.submittedData();
    expect(data.hfc_flags).toEqual([]);
  });

  test('enumerator confirms the unusual answer -> submitted WITH a flag (no infinite loop)', async () => {
    await fillMinimumValidForm(survey, { age: 12, education: 'college' });
    await survey.submit();
    await survey.page.getByTestId('hfc-confirm').click();
    const data = await survey.submittedData();
    expect(data.hfc_flags).toEqual([{ rule_id: 'HFC_AGE_EDU', action: 'reask_and_flag', status: 'confirmed_by_enumerator' }]);

    // Submitting again does not re-ask for the same confirmed answers
    await survey.submit();
    await expect(survey.page.getByTestId('hfc-alert')).toBeHidden();
    await survey.submittedData();
  });

  test('two rules fire together -> both shown in ONE re-ask, one confirmation clears both', async () => {
    await fillMinimumValidForm(survey, { age: 12, education: 'college' });
    await survey.answer('sleep_well', 'select_one', 'yes');
    await survey.answer('sleep_hours', 'decimal', 4);
    await survey.submit();
    await expect(survey.page.getByTestId('hfc-HFC_AGE_EDU')).toBeVisible();
    await expect(survey.page.getByTestId('hfc-HFC_SLEEP')).toBeVisible();
    await survey.page.getByTestId('hfc-confirm').click();
    const data = await survey.submittedData();
    expect(data.hfc_flags.map(f => f.rule_id).sort()).toEqual(['HFC_AGE_EDU', 'HFC_SLEEP']);
  });

  test('changing to ANOTHER invalid value re-asks again (confirmation is tied to the exact answers)', async () => {
    await fillMinimumValidForm(survey, { age: 12, education: 'college' });
    await survey.submit();
    await survey.page.getByTestId('hfc-confirm').click();
    await survey.submittedData();
    await survey.answer('age', 'integer', 13);
    await survey.submit();
    await expect(survey.page.getByTestId('hfc-HFC_AGE_EDU')).toBeVisible();
  });
});

/** Fills just the required root questions so the form can be submitted. */
async function fillMinimumValidForm(s, o = {}) {
  await s.answer('respondent_name', 'text', o.respondent_name || 'Sunita Devi');
  await s.answer('has_hobby', 'select_one', o.has_hobby || 'no');
  await s.answer('age', 'integer', o.age ?? 30);
  await s.answer('education', 'select_one', o.education || 'secondary');
  await s.answer('household_size', 'integer', o.household_size ?? 1);
  if ((o.household_size ?? 1) === 1) {
    await s.answer('members-1-member_name', 'text', 'Sunita Devi');
    await s.answer('members-1-member_age', 'integer', o.age ?? 30);
  }
}
