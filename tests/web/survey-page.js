// Page object for the schema-driven survey form
const { expect } = require('@playwright/test');

class SurveyPage {
  constructor(page) { this.page = page; }

  async open(schemaFile, surveyNumber) {
    const qs = new URLSearchParams();
    if (schemaFile) qs.set('schema', schemaFile);
    if (surveyNumber) qs.set('survey', String(surveyNumber));
    await this.page.goto(`/${qs.toString() ? '?' + qs : ''}`);
    await expect(this.page.locator('body[data-ready="true"]')).toBeAttached();
  }

  question(key) { return this.page.getByTestId(`q-${key}`); }
  error(key) { return this.page.getByTestId(`error-${key}`); }

  /** Answer any question type. key = DOM key (question id, or "members-1-member_age" in a roster). */
  async answer(key, type, value) {
    if (type === 'select_one' && await this.page.locator(`select#in-${key}`).count()) {
      await this.page.locator(`select#in-${key}`).selectOption(value === '' ? '' : String(value));   // dropdown
    } else if (type === 'select_one') {
      await this.page.locator(`#in-${key}-${value}`).check();                                       // radio buttons
    } else if (type === 'select_multiple') {
      const wanted = [].concat(value);
      for (const box of await this.page.locator(`input[name="${key}"]`).all()) {
        const v = await box.getAttribute('value');
        if (wanted.includes(v)) await box.check(); else await box.uncheck();
      }
    } else {
      await this.page.locator(`#in-${key}`).fill(value === '' || value === undefined ? '' : String(value));
    }
  }

  async submit() { await this.page.getByTestId('submit').click(); }

  async submittedData() {
    const out = this.page.getByTestId('submission');
    await expect(out).toBeVisible();
    return JSON.parse(await out.textContent());
  }
}

module.exports = { SurveyPage };
