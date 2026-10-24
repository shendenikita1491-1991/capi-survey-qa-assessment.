/* Renders a survey form dynamically from a JSON schema (like the Android app does).
 * Open /?schema=<file in /schema> to render any schema. */
(function () {
  const { evaluate, runHfc, isEmpty } = window.SurveyLogic;
  const params = new URLSearchParams(location.search);
  const schemaFile = params.get('schema') || 'household-survey.schema.json';
  // e.g. /?schema=sample-survey-schema.json&survey=3  (the provided builder file, 3rd survey)

  const form = document.getElementById('survey');
  const hfcBox = document.getElementById('hfc');
  const output = document.getElementById('output');

  let schema;
  const answers = {};               // root answers
  const repeats = {};               // repeatId -> [ { memberAnswers } ]
  const acknowledged = new Set();   // HFC rule+answers combinations the enumerator confirmed
  const reasked = new Set();        // reask_once rules already shown once

  const el = (tag, attrs = {}, ...children) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'text') e.textContent = v; else if (v !== undefined && v !== null) e.setAttribute(k, v);
    }
    children.forEach(c => c && e.appendChild(c));
    return e;
  };

  /** Build one question. key = unique DOM key, store = object holding the answer. */
  function renderQuestion(q, key, store) {
    const wrap = el('div', { class: 'question', 'data-testid': `q-${key}`, 'data-qid': q.id });
    const inputId = `in-${key}`;
    const required = q.required ? el('span', { class: 'req', text: ' *' }) : null;
    const onChange = () => { readValue(); refresh(); };
    let readValue;

    if (q.type === 'note') {
      wrap.appendChild(el('p', { text: q.label }));
      readValue = () => {};
    } else if (q.type === 'select_one' && q.ui === 'dropdown') {
      const select = el('select', { id: inputId, name: key });
      select.appendChild(el('option', { value: '', text: 'Select…' }));
      q.options.forEach(o => {
        const opt = el('option', { value: o.value, text: o.label });
        if (store[q.id] === o.value) opt.selected = true;
        select.appendChild(opt);
      });
      select.addEventListener('change', onChange);
      wrap.appendChild(el('label', { for: inputId, text: q.label }, required));
      if (q.hint) wrap.appendChild(el('div', { class: 'hint', text: q.hint }));
      wrap.appendChild(select);
      readValue = () => { if (select.value) store[q.id] = select.value; else delete store[q.id]; };
    } else if (q.type === 'select_one' || q.type === 'select_multiple') {
      const multi = q.type === 'select_multiple';
      const fs = el('fieldset', {}, el('legend', { text: q.label }, required));
      q.options.forEach(o => {
        const id = `${inputId}-${o.value}`;
        const input = el('input', { type: multi ? 'checkbox' : 'radio', name: key, id, value: o.value });
        const cur = store[q.id];
        if (multi ? (cur || []).includes(o.value) : cur === o.value) input.checked = true;
        input.addEventListener('change', onChange);
        fs.appendChild(el('label', { class: 'choice', for: id }, input, document.createTextNode(o.label)));
      });
      wrap.appendChild(fs);
      readValue = () => {
        const checked = [...wrap.querySelectorAll('input:checked')].map(i => i.value);
        if (multi) { if (checked.length) store[q.id] = checked; else delete store[q.id]; }
        else if (checked.length) store[q.id] = checked[0]; else delete store[q.id];
      };
    } else {
      const type = { integer: 'number', decimal: 'number', date: 'date' }[q.type] || 'text';
      const input = el('input', { type, id: inputId, name: key, min: q.min, max: q.max, step: q.type === 'decimal' ? 'any' : (q.type === 'integer' ? '1' : undefined) });
      if (!isEmpty(store[q.id])) input.value = store[q.id];
      input.addEventListener('input', onChange);
      wrap.appendChild(el('label', { for: inputId, text: q.label }, required));
      if (q.hint) wrap.appendChild(el('div', { class: 'hint', text: q.hint }));
      wrap.appendChild(input);
      readValue = () => {
        const v = input.value.trim();
        if (v === '') delete store[q.id];
        else store[q.id] = ['integer', 'decimal'].includes(q.type) ? Number(v) : v;
      };
    }
    // Android spec display order: Question Text > Question Hint > Input > Checklist Guide
    if (q.checklist) wrap.appendChild(el('div', { class: 'checklist', 'data-testid': `checklist-${key}`, text: q.checklist }));
    wrap.appendChild(el('div', { class: 'error', 'data-testid': `error-${key}`, hidden: '' }));
    wrap._q = q; wrap._store = store; wrap._key = key;
    return wrap;
  }

  function renderRepeat(q) {
    const wrap = el('div', { class: 'question', 'data-testid': `q-${q.id}`, 'data-qid': q.id });
    wrap.appendChild(el('strong', { text: `${q.label}s` }));
    const box = el('div', { 'data-testid': `repeat-${q.id}` });
    wrap.appendChild(box);
    repeats[q.id] = [];
    if (!q.repeat_count) {
      const add = el('button', { type: 'button', class: 'secondary', 'data-testid': `add-${q.id}`, text: `+ Add ${q.label}` });
      add.addEventListener('click', () => { repeats[q.id].push({}); drawRepeat(q, wrap); refresh(); });
      wrap.appendChild(add);
    }
    wrap._q = q; wrap._isRepeat = true;
    return wrap;
  }

  function drawRepeat(q, wrap) {
    const box = wrap.querySelector(`[data-testid="repeat-${q.id}"]`);
    box.innerHTML = '';
    repeats[q.id].forEach((member, i) => {
      const inst = el('div', { class: 'roster', 'data-testid': `${q.id}-${i + 1}` }, el('h3', { text: `${q.label} ${i + 1}` }));
      q.questions.forEach(sq => inst.appendChild(renderQuestion(sq, `${q.id}-${i + 1}-${sq.id}`, member)));
      box.appendChild(inst);
    });
  }

  function syncRepeatCounts() {
    for (const w of form.querySelectorAll(':scope > .question')) {
      const q = w._q;
      if (!w._isRepeat || !q.repeat_count) continue;
      const wanted = Math.max(0, Math.min(30, parseInt(answers[q.repeat_count], 10) || 0));
      const list = repeats[q.id];
      if (list.length === wanted) continue;
      while (list.length < wanted) list.push({});
      list.length = wanted; // removing members also removes their answers
      drawRepeat(q, w);
    }
  }

  function clearInputs(wrap) {
    wrap.querySelectorAll('input').forEach(i => { if (i.type === 'radio' || i.type === 'checkbox') i.checked = false; else i.value = ''; });
    wrap.querySelectorAll('select').forEach(sel => { sel.value = ''; });
  }

  /** Re-evaluate all skip logic. Hidden questions lose their value (and that can hide others -> loop). */
  function refresh() {
    syncRepeatCounts();
    for (let pass = 0; pass < 10; pass++) {
      let changed = false;
      for (const w of form.querySelectorAll('.question')) {
        const q = w._q;
        const inRepeat = w._store && w._store !== answers;
        const ctx = inRepeat ? { ...answers, ...w._store } : answers;
        const visible = evaluate(q.visible_if, ctx);
        w.hidden = !visible;
        if (!visible && !w._isRepeat && !isEmpty(w._store[q.id])) {
          delete w._store[q.id]; clearInputs(w); changed = true;
        }
      }
      if (!changed) break;
    }
  }

  function validate() {
    let ok = true;
    for (const w of form.querySelectorAll('.question')) {
      if (w._isRepeat) continue;
      const err = w.querySelector(':scope > .error');
      err.hidden = true; err.textContent = '';
      if (w.hidden || w.closest('[hidden]')) continue;
      const q = w._q, v = w._store[q.id];
      let msg = '';
      if (q.required && isEmpty(v)) msg = 'This answer is required';
      else if (typeof v === 'number' && q.min !== undefined && v < q.min) msg = `Must be at least ${q.min}`;
      else if (typeof v === 'number' && q.max !== undefined && v > q.max) msg = `Must be at most ${q.max}`;
      else if (q.type === 'integer' && typeof v === 'number' && !Number.isInteger(v)) msg = 'Must be a whole number';
      if (msg) { ok = false; err.textContent = msg; err.hidden = false; }
    }
    return ok;
  }

  const signature = rule => rule.id + '|' + JSON.stringify((rule.questions || []).map(id => answers[id]));

  /**
   * HFC actions (Builder spec §11):
   *   flag_silently  - no prompt, answer accepted and flagged
   *   reask_once     - re-ask once; on the next submit the answer is accepted and flagged
   *   reask_and_flag - re-ask every time until the enumerator confirms; always flagged
   *   block          - cannot submit until the answer is corrected (no "answers are correct" button)
   * ("flag" is the engine's older name for flag_silently, kept for the household sample schema.)
   */
  function submit() {
    output.hidden = true;
    if (!validate()) return;
    const fired = runHfc(schema, answers);
    const blocking = fired.filter(r => r.action === 'block');
    const pending = fired.filter(r =>
      (r.action === 'reask_and_flag' && !acknowledged.has(signature(r))) ||
      (r.action === 'reask_once' && !reasked.has(r.id)));
    if (blocking.length || pending.length) {
      pending.filter(r => r.action === 'reask_once').forEach(r => reasked.add(r.id));
      return showHfc([...blocking, ...pending], blocking.length > 0);
    }
    hfcBox.hidden = true;
    const status = r => ({ reask_and_flag: 'confirmed_by_enumerator', reask_once: 'accepted_after_reask' }[r.action] || 'flagged_silently');
    const data = {
      survey_id: schema.survey_id, schema_version: schema.schema_version,
      answers: { ...answers, ...Object.fromEntries(Object.entries(repeats).map(([k, v]) => [k, v])) },
      hfc_flags: fired.map(r => {
        const f = { rule_id: r.id, action: r.action, status: status(r) };
        if (r.severity) f.severity = r.severity;
        return f;
      }),
    };
    output.textContent = JSON.stringify(data, null, 2);
    output.hidden = false;
    document.getElementById('out-title').hidden = false;
  }

  function showHfc(rules, blocked) {
    hfcBox.innerHTML = '';
    hfcBox.appendChild(el('strong', { text: blocked ? 'Please correct these answers' : 'Please check these answers' }));
    rules.forEach(r => hfcBox.appendChild(el('p', { 'data-testid': `hfc-${r.id}`, 'data-action': r.action, text: r.message })));
    const fix = el('button', { type: 'button', class: 'secondary', 'data-testid': 'hfc-change', text: 'Change answers' });
    fix.addEventListener('click', () => {
      hfcBox.hidden = true;
      const first = form.querySelector(`[data-qid="${rules[0].questions[0]}"] input, [data-qid="${rules[0].questions[0]}"] select`);
      if (first) first.focus();
    });
    hfcBox.append(fix);
    if (!blocked) {   // a "block" check offers no way to accept the answer
      const ok = el('button', { type: 'button', 'data-testid': 'hfc-confirm', text: 'Answers are correct' });
      ok.addEventListener('click', () => { rules.forEach(r => acknowledged.add(signature(r))); submit(); });
      hfcBox.append(document.createTextNode(' '), ok);
    }
    hfcBox.hidden = false;
  }

  async function init() {
    // A broken schema must produce a clear message, never a blank or half-rendered form
    try {
      const res = await fetch(`/schema/${encodeURIComponent(schemaFile)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const doc = JSON.parse(await res.text());
      // Builder format ({ surveys: [...] }) is converted; ?survey=N picks the survey (1-based)
      schema = doc.surveys ? window.BuilderFormat.fromBuilderFormat(doc, Number(params.get('survey') || 1) - 1) : doc;
      const problems = window.SurveyLogic.validateSchema(schema);
      if (problems.length) throw new Error(problems.join('; '));
    } catch (e) {
      document.getElementById('survey-title').textContent = 'This survey could not be loaded';
      const msg = el('p', { 'data-testid': 'load-error', class: 'error', text: `The form definition is invalid (${e.message}). Please contact your supervisor.` });
      form.appendChild(msg);
      document.getElementById('submit').hidden = true;
      document.body.dataset.ready = 'error';
      return;
    }
    document.getElementById('survey-title').textContent = schema.title || schema.survey_id;
    let lastSection;
    schema.questions.forEach(q => {
      if (q.section && q.section !== lastSection) {
        form.appendChild(el('h2', { class: 'section-title', text: q.section }));
        // Android spec: Section Title > Section Hint/Checklist > questions
        if (q.sectionChecklist) form.appendChild(el('div', { class: 'section-checklist', 'data-testid': 'section-checklist', text: q.sectionChecklist }));
        lastSection = q.section;
      }
      form.appendChild(q.type === 'repeat' ? renderRepeat(q) : renderQuestion(q, q.id, answers));
    });
    refresh();
    document.getElementById('submit').addEventListener('click', submit);
    document.body.dataset.ready = 'true';
  }
  init();
})();
