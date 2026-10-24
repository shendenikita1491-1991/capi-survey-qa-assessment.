/**
 * Survey logic shared by the web form AND the Node tests.
 * (The Android app has its own Kotlin engine; the proposal is that both are tested against the same
 *  data tables - e.g. test-cases/hfc-engine-test-plan.csv - so web and app can't disagree.)
 *   evaluate(condition, answers)  -> skip logic / HFC conditions
 *   runHfc(schema, answers)       -> which HFC rules fire
 *   validateSchema(schema)        -> contract checks a builder release must pass
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SurveyLogic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const OPS = ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'contains', 'not_empty', 'empty', 'in'];
  const TYPES = ['text', 'integer', 'decimal', 'select_one', 'select_multiple', 'date', 'note', 'repeat'];

  const isEmpty = v => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

  function compare(op, actual, expected) {
    switch (op) {
      case 'eq': return !isEmpty(actual) && String(actual) === String(expected);
      case 'neq': return !isEmpty(actual) && String(actual) !== String(expected);
      case 'in': return !isEmpty(actual) && expected.map(String).includes(String(actual));
      case 'contains': return Array.isArray(actual) ? actual.includes(expected) : (typeof actual === 'string' && actual.includes(String(expected)));
      case 'not_empty': return !isEmpty(actual);
      case 'empty': return isEmpty(actual);
      case 'lt': case 'lte': case 'gt': case 'gte': {
        if (isEmpty(actual)) return false;             // unanswered never satisfies a numeric rule
        const a = Number(actual), b = Number(expected);
        if (Number.isNaN(a) || Number.isNaN(b)) return false;
        return op === 'lt' ? a < b : op === 'lte' ? a <= b : op === 'gt' ? a > b : a >= b;
      }
      default: throw new Error(`Unknown operator: ${op}`);
    }
  }

  /** answers: flat object { questionId: value }  (inside a roster: that member's answers + parent answers) */
  function evaluate(cond, answers) {
    if (!cond) return true;
    if (cond.all) return cond.all.every(c => evaluate(c, answers));
    if (cond.any) return cond.any.some(c => evaluate(c, answers));
    if (cond.not) return !evaluate(cond.not, answers);
    return compare(cond.op, answers[cond.question], cond.value);
  }

  function runHfc(schema, answers) {
    return (schema.hfc_rules || []).filter(rule => evaluate(rule.when, answers));
  }

  function collectRefs(cond, out = []) {
    if (!cond) return out;
    if (cond.all) cond.all.forEach(c => collectRefs(c, out));
    else if (cond.any) cond.any.forEach(c => collectRefs(c, out));
    else if (cond.not) collectRefs(cond.not, out);
    else out.push(cond);
    return out;
  }

  function validateSchema(schema) {
    const errors = [];
    if (!schema || !Array.isArray(schema.questions)) return ['schema.questions must be an array'];
    const seen = new Set();

    function walk(questions, scope, path) {
      const local = new Set(scope);
      questions.forEach((q, i) => {
        const where = `${path}[${i}] (${q.id || 'no id'})`;
        if (!q.id) errors.push(`${where}: missing id`);
        else if (seen.has(q.id)) errors.push(`${where}: duplicate id "${q.id}"`);
        seen.add(q.id);
        if (!TYPES.includes(q.type)) errors.push(`${where}: unknown type "${q.type}"`);
        if (!q.label && q.type !== 'note') errors.push(`${where}: missing label`);
        if (['select_one', 'select_multiple'].includes(q.type)) {
          if (!Array.isArray(q.options) || q.options.length === 0) errors.push(`${where}: select question has no options`);
          else {
            const vals = q.options.map(o => o.value);
            if (new Set(vals).size !== vals.length) errors.push(`${where}: duplicate option values`);
          }
        }
        if (q.min !== undefined && q.max !== undefined && q.min > q.max) errors.push(`${where}: min > max`);
        for (const ref of collectRefs(q.visible_if)) {
          if (!OPS.includes(ref.op)) errors.push(`${where}: unknown operator "${ref.op}"`);
          if (!local.has(ref.question)) errors.push(`${where}: visible_if refers to "${ref.question}" which is not an earlier question`);
          if (ref.question === q.id) errors.push(`${where}: visible_if refers to itself`);
        }
        if (q.type === 'repeat') {
          if (!Array.isArray(q.questions) || !q.questions.length) errors.push(`${where}: repeat has no questions`);
          if (q.repeat_count && !local.has(q.repeat_count)) errors.push(`${where}: repeat_count "${q.repeat_count}" is not an earlier question`);
          walk(q.questions || [], local, `${path}[${i}].questions`);
        }
        if (q.id) local.add(q.id);
      });
      return local;
    }
    const all = walk(schema.questions, new Set(), 'questions');

    (schema.hfc_rules || []).forEach((r, i) => {
      if (!r.id) errors.push(`hfc_rules[${i}]: missing id`);
      // Builder spec §11 actions (+ 'flag', the engine's older name for flag_silently)
      if (!['flag_silently', 'flag', 'reask_once', 'reask_and_flag', 'block'].includes(r.action))
        errors.push(`hfc_rules[${i}]: unknown action "${r.action}"`);
      for (const ref of collectRefs(r.when)) {
        if (!all.has(ref.question)) errors.push(`hfc_rules[${i}] (${r.id}): unknown question "${ref.question}"`);
        if (!OPS.includes(ref.op)) errors.push(`hfc_rules[${i}] (${r.id}): unknown operator "${ref.op}"`);
      }
    });
    return errors;
  }

  return { evaluate, runHfc, validateSchema, collectRefs, isEmpty, OPS, TYPES };
});
