const crypto = require('crypto');

/** One survey record as the Android app would build it from its Room table. */
function makeRecord(overrides = {}) {
  return {
    local_id: 'School_1',                     // device-local, NOT globally unique
    client_uuid: crypto.randomUUID(),         // generated on the device when the record is created
    survey_id: 'school_survey_v1',
    schema_version: 3,
    entity_type: 'school',
    entity: { name: 'Govt Primary School', village_code: 'VIL-001', gps: { lat: 23.0225, lng: 72.5714 } },
    answers: { has_toilet: 'yes', students_count: 120, teachers_count: 4 },
    collected_at: '2026-10-23T10:00:00+05:30',
    ...overrides,
  };
}

/** A sync batch = what one device uploads in one background WorkManager run. */
function makeBatch(deviceId, userId, records, overrides = {}) {
  return { batch_id: crypto.randomUUID(), device_id: deviceId, user_id: userId, app_version: '2.4.1', records, ...overrides };
}

async function resetServer(request) {
  const res = await request.post('/__reset');
  if (!res.ok()) throw new Error('could not reset mock server');
}

async function storedByLocalId(request, localId) {
  const res = await request.get(`/surveys?local_id=${encodeURIComponent(localId)}`);
  return (await res.json()).items;
}

/** Sync with retry, honouring 429/503 Retry-After (never earlier) plus random jitter,
 *  like the app's WorkManager backoff should, so retries don't all land at the same instant. */
async function syncWithRetry(request, batch, { maxAttempts = 8 } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await request.post('/sync-survey', { data: batch });
    if (![429, 503].includes(res.status())) return { res, attempt };
    const retryAfterMs = Number(res.headers()['retry-after'] || 1) * 1000;
    const jitterMs = Math.random() * 500;
    await new Promise(r => setTimeout(r, retryAfterMs + jitterMs));
  }
  throw new Error(`gave up after ${maxAttempts} attempts`);
}

module.exports = { makeRecord, makeBatch, resetServer, storedByLocalId, syncWithRetry };
