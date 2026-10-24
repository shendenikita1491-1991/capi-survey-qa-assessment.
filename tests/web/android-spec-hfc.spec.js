// @ts-check
/**
 * Behaviour from the two reference specs, on schema/android-spec-hfc.json:
 *   - Android spec HFC example: q_3 (hours slept) > 16 -> Soft, re-ask ("unusually high")
 *   - Builder spec §11 action semantics: reask_once, block, flag_silently
 *   - Android spec: visibilityLogic.enabled = false -> always visible; range validation (0-24)
 *   - Android spec display order: Section Title > Section Checklist > Question > Hint > Input > Checklist Guide
 */
const { test, expect } = require('@playwright/test');
const { SurveyPage } = require('./survey-page');

const FILE = 'android-spec-hfc.json';

async function fill(s, { age = 30, slept = 'No', hours = 8 } = {}) {
  await s.answer('q_1', 'decimal', age);
  await s.answer('q_2', 'select_one', slept);
  await s.answer('q_3', 'decimal', hours);
}

test.describe('Android spec HFC example: hours slept > 16 (reask_once, Soft)', () => {
  let s;
  test.beforeEach(async ({ page }) => { s = new SurveyPage(page); await s.open(FILE, 1); });

  test('questions with visibilityLogic.enabled = false are always visible', async () => {
    for (const id of ['q_1', 'q_2', 'q_3']) await expect(s.question(id)).toBeVisible();
  });

  test('20 hours -> re-asked once; submitting again accepts the answer WITH a Soft flag', async ({ page }) => {
    await fill(s, { hours: 20 });
    await s.submit();
    await expect(page.getByTestId('hfc-hfc_sleep_plausible')).toContainText('unusually high');
    await expect(page.getByTestId('submission')).toBeHidden();
    await page.getByTestId('hfc-change').click();      // enumerator re-asks, respondent repeats 20
    await s.submit();                                   // second time: accepted, no new prompt
    await expect(page.getByTestId('hfc-alert')).toBeHidden();
    const data = await s.submittedData();
    expect(data.answers.q_3).toBe(20);
    expect(data.hfc_flags).toEqual([{ rule_id: 'hfc_sleep_plausible', action: 'reask_once', status: 'accepted_after_reask', severity: 'Soft' }]);
  });

  test('re-asked answer corrected to 8 -> submitted with no flag', async ({ page }) => {
    await fill(s, { hours: 20 });
    await s.submit();
    await page.getByTestId('hfc-change').click();
    await s.answer('q_3', 'decimal', 8);
    await s.submit();
    expect((await s.submittedData()).hfc_flags).toEqual([]);
  });

  for (const [hours, fires] of [[16, false], [16.5, true], [24, true], [0, false]]) {
    test(`boundary: ${hours} hours -> ${fires ? 're-ask' : 'no re-ask'} (rule is strictly > 16)`, async ({ page }) => {
      await fill(s, { hours });
      await s.submit();
      if (fires) await expect(page.getByTestId('hfc-hfc_sleep_plausible')).toBeVisible();
      else expect((await s.submittedData()).hfc_flags).toEqual([]);
    });
  }

  test('25 hours fails the range validation (max 24) BEFORE any HFC runs', async ({ page }) => {
    await fill(s, { hours: 25 });
    await s.submit();
    await expect(s.error('q_3')).toHaveText('Must be at most 24');
    await expect(page.getByTestId('hfc-alert')).toBeHidden();
    await expect(page.getByTestId('submission')).toBeHidden();
  });
});

test.describe('Builder spec §11 action semantics', () => {
  let s;
  test.beforeEach(async ({ page }) => { s = new SurveyPage(page); await s.open(FILE, 1); });

  test('block (Hard): age 3 cannot be submitted, there is no "answers are correct" button', async ({ page }) => {
    await fill(s, { age: 3 });
    for (let i = 0; i < 3; i++) {                       // stays blocked however often you submit
      await s.submit();
      await expect(page.getByTestId('hfc-hfc_age_too_low')).toBeVisible();
      await expect(page.getByTestId('hfc-confirm')).toHaveCount(0);
      await expect(page.getByTestId('submission')).toBeHidden();
    }
    await page.getByTestId('hfc-change').click();
    await s.answer('q_1', 'decimal', 6);                // corrected -> submits
    await s.submit();
    expect((await s.submittedData()).hfc_flags).toEqual([]);
  });

  test('block and reask_once firing together: the prompt has no accept button until the block is fixed', async ({ page }) => {
    await fill(s, { age: 3, hours: 20 });
    await s.submit();
    await expect(page.getByTestId('hfc-hfc_age_too_low')).toBeVisible();
    await expect(page.getByTestId('hfc-hfc_sleep_plausible')).toBeVisible();
    await expect(page.getByTestId('hfc-confirm')).toHaveCount(0);
    await s.answer('q_1', 'decimal', 30);
    await s.submit();                                   // reask_once was already shown -> accepted and flagged
    const data = await s.submittedData();
    expect(data.hfc_flags.map(f => f.rule_id)).toEqual(['hfc_sleep_plausible']);
  });

  test('flag_silently (Observation): age 105 submits without any prompt but carries a flag', async ({ page }) => {
    await fill(s, { age: 105 });
    await s.submit();
    await expect(page.getByTestId('hfc-alert')).toBeHidden();
    expect((await s.submittedData()).hfc_flags).toEqual([{ rule_id: 'hfc_age_very_old', action: 'flag_silently', status: 'flagged_silently', severity: 'Observation' }]);
  });
});

test.describe('Android spec display order', () => {
  test('Section Title > Section Checklist > Question Text > Hint > Input > Checklist Guide', async ({ page }) => {
    const s = new SurveyPage(page);
    await s.open(FILE, 1);
    const sectionOrder = await page.evaluate(() => {
      const form = document.getElementById('survey');
      return [...form.children].slice(0, 3).map(e => e.className);
    });
    expect(sectionOrder).toEqual(['section-title', 'section-checklist', 'question']);
    await expect(page.getByTestId('section-checklist')).toHaveText('Ask about last night only, not a usual night.');

    const order = await s.question('q_3').evaluate(q => [...q.children].filter(c => !c.hidden).map(c =>
      c.tagName === 'LABEL' ? 'question' : c.tagName === 'INPUT' || c.tagName === 'SELECT' ? 'input' : c.className));
    expect(order).toEqual(['question', 'hint', 'input', 'checklist']);
    await expect(page.getByTestId('checklist-q_3')).toHaveText('Count from going to bed to waking up.');
  });
});
