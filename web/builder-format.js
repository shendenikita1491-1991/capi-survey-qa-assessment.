/**
 * Support for the Survey Builder's JSON format.
 *
 *   fromBuilderFormat(doc, surveyIndex)  -> converts one survey into the form/test engine format
 *   auditBuilderSchema(doc)              -> contract + quality checks; returns a list of findings
 *
 * Rules follow the two reference documents:
 *   - "2.Survey Builder Tool Capabilities.html"  (input types, visibility conditions, HFC actions/ops, model)
 *   - "1.Android App Specification.html"         (visibility, validationRules, Soft HFC, display order)
 *
 * Provided schema shape (schema/provided/3.Sample_Survey_Schema.json):
 *   { surveys: [ { surveyData: { title, sections: [ { sectionId, title, sectionChecklist, questions: [
 *       { questionId, questionText, hintText, inputType, options, checklistGuide, isRequired,
 *         validationRules, visibilityLogic: { enabled, targetQuestion, condition, value },
 *         formChecks: [ { id, action, match, severity, show_sup, logic: [ { attr, op, val } ], msg } ] } ] } ] } } ] }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BuilderFormat = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // Builder spec §3 - the 13 input types it lists (the spec text says "twenty")
  const BUILDER_TYPES = ['Text', 'TextArea', 'Number', 'Dropdown', 'Radio', 'Checkbox', 'Matrix', 'Date', 'Image', 'Audio', 'GPS', 'Roster', 'Note'];
  // Types this web demo renders (the others would need device features: camera, mic, GPS...)
  const RENDERED = { Text: 'text', TextArea: 'text', Number: 'decimal', Dropdown: 'select_one', Radio: 'select_one', Checkbox: 'select_multiple', Date: 'date', Note: 'note' };
  // Builder spec §8 - visibility conditions
  const VIS_CONDITIONS = { equals: 'eq', not_equals: 'neq', contains: 'contains', greater_than: 'gt', less_than: 'lt', is_empty: 'empty', is_not_empty: 'not_empty' };
  // Builder spec §11 - HFC operators, actions, severities
  const HFC_OPS = { '=': 'eq', '!=': 'neq', '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte', contains: 'contains', in: 'in', empty: 'empty', not_empty: 'not_empty' };
  const HFC_ACTIONS = ['flag_silently', 'reask_once', 'reask_and_flag', 'block'];
  const HFC_SEVERITIES = ['Critical', 'Hard', 'Soft', 'Observation'];

  const asText = v => (Array.isArray(v) ? v.join(' ') : v) || undefined;
  const optionLabel = o => (typeof o === 'string' ? o : (o && o.label));
  const questionsOf = survey => (survey.surveyData.sections || []).flatMap(sec =>
    (sec.questions || sec.items || []).map(q => ({ ...q, _section: sec })));

  /** Convert one survey of the builder file into the engine format used by the form and tests. */
  function fromBuilderFormat(doc, surveyIndex = 0) {
    const survey = doc.surveys[surveyIndex];
    const qs = questionsOf(survey);
    const questions = qs.map(q => {
      const sec = q._section;
      const out = {
        id: q.questionId,
        type: RENDERED[q.inputType] || 'note',
        ui: q.inputType === 'Dropdown' ? 'dropdown' : undefined,
        label: q.questionText,
        // The app reads "hintText" (spec). A question using another key shows no hint - see defect PS-08.
        hint: asText(q.hintText),
        checklist: asText(q.checklistGuide),
        section: sec.title,
        sectionChecklist: asText(sec.sectionChecklist || sec.checklistGuide),
        required: !!q.isRequired,
      };
      if (['Dropdown', 'Radio', 'Checkbox'].includes(q.inputType)) {
        out.options = (q.options || []).map(o => ({ value: optionLabel(o), label: optionLabel(o) }));
      }
      const vr = q.validationRules;
      if (vr && !Array.isArray(vr) && vr.type === 'range') { out.min = Number(vr.min); out.max = Number(vr.max); }
      const vis = q.visibilityLogic;
      if (vis && vis.enabled) out.visible_if = { question: vis.targetQuestion, op: VIS_CONDITIONS[vis.condition] || vis.condition, value: vis.value };
      return out;
    });

    // HFC: a rule is loaded only if every condition has a valid "attr" and operator (strict, like the app
    // should be: a typo must not silently become a rule that compares against an undefined question).
    const hfc_rules = [];
    for (const q of qs) for (const fc of q.formChecks || []) {
      const logic = fc.logic || [];
      if (!logic.length || logic.some(c => !c.attr || !HFC_OPS[c.op])) continue;
      const conds = logic.map(c => ({ question: c.attr, op: HFC_OPS[c.op], value: c.val }));
      hfc_rules.push({
        id: fc.id, action: fc.action, severity: fc.severity, show_sup: !!fc.show_sup, message: fc.msg,
        questions: logic.map(c => c.attr),
        when: fc.match === 'any' ? { any: conds } : { all: conds },
      });
    }
    return {
      survey_id: survey.surveyData.id || `survey_${surveyIndex + 1}`,
      title: survey.surveyData.title,
      schema_version: survey.surveyData.version || null,
      questions, hfc_rules,
    };
  }

  /** Contract and quality audit. Each finding: { code, severity, survey, path, message }. */
  function auditBuilderSchema(doc) {
    const findings = [];
    const add = (code, severity, survey, path, message) => findings.push({ code, severity, survey, path, message });
    if (!doc || !Array.isArray(doc.surveys)) { add('NO_SURVEYS', 'error', null, '', 'surveys must be an array'); return findings; }

    const validationShapes = new Set();
    const model = { questionsKey: false, sectionChecklistString: false, hintString: false, checklistString: false, validationRulesKey: false };

    doc.surveys.forEach((s, si) => {
      const sd = s.surveyData || {};
      const where = `surveys[${si}] "${sd.title}"`;
      if (!sd.id) add('NO_SURVEY_ID', 'error', si, where, 'survey has no id (Builder spec §2: Form has id) - synced answers cannot be linked to the exact form');
      if (!sd.version) add('NO_SCHEMA_VERSION', 'warning', si, where, 'survey has no version (Builder spec §2) - old app versions cannot tell which form version they hold');
      if (!sd.language) add('NO_LANGUAGE', 'warning', si, where, 'survey has no language (Builder spec §2) - forms are produced per language, so the app cannot tell which one it got');

      (sd.sections || []).forEach((sec, xi) => {
        for (const f of ['sectionId', 'title', 'learningOutcome']) {
          if (!sec[f]) add('SECTION_FIELD_MISSING', 'info', si, `${where} sections[${xi}]`, `section "${sec.title}" has no ${f}`);
        }
        if (sec.questions && !sec.items) model.questionsKey = true;
        if (typeof sec.sectionChecklist === 'string') model.sectionChecklistString = true;
      });

      const qs = questionsOf(s);
      const seen = new Map();
      qs.forEach((q, qi) => {
        const qpath = `${where} ${q.questionId}`;
        if (!q.questionId) add('NO_QUESTION_ID', 'error', si, qpath, 'question has no questionId');
        else if (seen.has(q.questionId)) add('DUPLICATE_QUESTION_ID', 'error', si, qpath, `questionId ${q.questionId} used twice in one survey`);
        seen.set(q.questionId, { q, index: qi });
        if (!BUILDER_TYPES.includes(q.inputType)) add('UNKNOWN_INPUT_TYPE', 'error', si, qpath, `inputType "${q.inputType}" is not a Builder input type`);
        if (q.questionHintText !== undefined && q.hintText === undefined) add('HINT_KEY_INCONSISTENT', 'warning', si, qpath, 'uses "questionHintText"; the spec and every other question use "hintText" - the app shows no hint');
        if (typeof q.hintText === 'string') model.hintString = true;
        if (typeof q.checklistGuide === 'string') model.checklistString = true;
        if (q.validationRules !== undefined) model.validationRulesKey = true;
        if (Array.isArray(q.validationRules)) validationShapes.add('array'); else if (q.validationRules) validationShapes.add('object');
        const vr = q.validationRules;
        if (vr && !Array.isArray(vr) && vr.type === 'range' && (typeof vr.min === 'string' || typeof vr.max === 'string')) {
          add('NUMBER_AS_STRING', 'warning', si, qpath, `range min/max are strings ("${vr.min}", "${vr.max}") - compared as text, "10" < "6" is true`);
        }
        if (['Dropdown', 'Radio', 'Checkbox'].includes(q.inputType)) {
          const labels = (q.options || []).map(optionLabel);
          if (!labels.length) add('DROPDOWN_NO_OPTIONS', 'error', si, qpath, 'choice question has no options');
          else if (new Set(labels).size !== labels.length) add('DUPLICATE_OPTION', 'error', si, qpath, 'duplicate options');
          if (labels.includes('Other')) {
            const specify = qs.some(o => o.visibilityLogic && o.visibilityLogic.enabled && o.visibilityLogic.targetQuestion === q.questionId && o.visibilityLogic.value === 'Other');
            if (!specify) add('OTHER_WITHOUT_SPECIFY', 'warning', si, qpath, '"Other" option has no follow-up question to specify it');
          }
        }
        const vis = q.visibilityLogic;
        if (vis && vis.enabled) {
          const target = seen.get(vis.targetQuestion);
          if (!target) add('VIS_TARGET_INVALID', 'error', si, qpath, `visibility targets "${vis.targetQuestion}" which is not an earlier question`);
          else if (['Dropdown', 'Radio'].includes(target.q.inputType) && !['is_empty', 'is_not_empty'].includes(vis.condition) &&
                   !(target.q.options || []).map(optionLabel).includes(vis.value)) {
            add('VIS_VALUE_NOT_AN_OPTION', 'error', si, qpath, `visibility value "${vis.value}" is not an option of ${vis.targetQuestion}`);
          }
          if (!VIS_CONDITIONS[vis.condition]) add('VIS_UNKNOWN_CONDITION', 'error', si, qpath, `condition "${vis.condition}" is not one of the Builder conditions (§8)`);
        }

        for (const fc of q.formChecks || []) {
          const fpath = `${qpath} formChecks "${fc.id}"`;
          if (!HFC_ACTIONS.includes(fc.action)) add('HFC_UNKNOWN_ACTION', 'error', si, fpath, `action "${fc.action}" is not a Builder action (§11)`);
          if (!HFC_SEVERITIES.includes(fc.severity)) add('HFC_UNKNOWN_SEVERITY', 'error', si, fpath, `severity "${fc.severity}" is not a Builder severity (§11)`);
          for (const c of fc.logic || []) {
            const ref = c.attr || c.questionId || c.questioID;
            if (!c.attr) add('HFC_BAD_KEY', 'error', si, fpath, `condition uses key "${Object.keys(c).find(k => k !== 'op' && k !== 'val') || '(none)'}" instead of "attr" (Builder spec §11) - the rule cannot find its question`);
            if (ref && !qs.some(o => o.questionId === ref)) add('HFC_UNKNOWN_QUESTION', 'error', si, fpath, `references unknown question ${ref}`);
            if (!HFC_OPS[c.op]) add('HFC_UNKNOWN_OP', 'error', si, fpath, `operator "${c.op}" is not a Builder operator (§11)`);
            if (['<', '<=', '>', '>='].includes(c.op) && typeof c.val === 'string') add('NUMBER_AS_STRING', 'warning', si, fpath, `numeric comparison against the string "${c.val}"`);
          }
          // Reachability: does a referenced question's visibility contradict the rule's own conditions?
          for (const c of fc.logic || []) {
            const ref = c.attr || c.questionId || c.questioID;
            const refQ = qs.find(o => o.questionId === ref);
            const v = refQ && refQ.visibilityLogic;
            if (!v || !v.enabled || v.condition !== 'equals') continue;
            const clash = (fc.logic || []).find(o => (o.attr || o.questionId || o.questioID) === v.targetQuestion && o.op === '=' && o.val !== v.value);
            if (clash) add('HFC_UNREACHABLE', 'error', si, fpath,
              `needs ${v.targetQuestion} = "${clash.val}", but ${ref} is only visible when ${v.targetQuestion} = "${v.value}" - the rule can never fire`);
          }
        }
      });
    });

    if (validationShapes.size > 1) add('VALIDATION_RULES_MIXED_TYPES', 'warning', null, 'validationRules', 'validationRules is sometimes an object and sometimes an array - typed parsers in the app may crash on one of them');
    // Schema vs the Builder's documented model (§2, §5, §7)
    const mm = (msg) => add('SCHEMA_VS_BUILDER_MODEL', 'warning', null, 'whole file', msg);
    if (model.questionsKey) mm('sections hold "questions"; the Builder model (§2) calls them "items"');
    if (model.sectionChecklistString) mm('sections use a "sectionChecklist" string; the Builder model (§2, §5) has a "checklistGuide[]" list');
    if (model.hintString) mm('"hintText" is a string; the Builder model (§5) defines "hintText[]" as a list');
    if (model.checklistString) mm('"checklistGuide" is a string; the Builder model (§5) defines a list');
    if (model.validationRulesKey) mm('questions use "validationRules" {type,min,max}; the Builder (§7) produces "validations[]" of {type,value,message}');
    return findings;
  }

  return { fromBuilderFormat, auditBuilderSchema, questionsOf, VIS_CONDITIONS, HFC_ACTIONS };
});
