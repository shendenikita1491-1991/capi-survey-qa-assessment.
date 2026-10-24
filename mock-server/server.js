/**
 * Mock CAPI backend used by the automated tests.
 *
 *   POST /sync-survey     - offline devices upload a batch of surveys
 *   GET  /surveys         - list stored surveys (test helper, filter by ?local_id= / ?device_id=)
 *   GET  /surveys/:id     - one stored survey
 *   POST /__reset         - clear all data (test helper)
 *   GET  /                - schema-driven web survey form (Scenario B)
 *   GET  /schema/...      - survey schema JSON files
 *
 * Sync rules implemented here (what the tests verify):
 *   1. A record's identity is (device_id + client_uuid), never local_id.
 *      Two devices can both send local_id "School_1" - each gets its own server_id.
 *   2. Re-sending the same record (same device_id + client_uuid + payload) is a
 *      no-op that returns the original server_id  -> safe retries.
 *   3. Same device_id + client_uuid but a DIFFERENT payload -> "conflict" (never silently overwrite).
 *      Response: 200 all ok, 409 all records conflicted, 207 mixed - each record has its own status.
 *   4. The same real-world entity (same normalised name + village) registered by two
 *      devices is stored twice and flagged "possible_duplicate" for supervisor review.
 *   5. Same Idempotency-Key + same body -> the exact same response is replayed;
 *      same key + different body -> 422.
 *   6. Load shedding: per-device rate limit and a global in-flight cap -> 429 / 503
 *      with Retry-After instead of crashing (protects against the 50,000-device "DDoS").
 *
 * Start a deliberately broken server to prove the tests catch bugs:
 *   MOCK_BUG=overwrite node mock-server/server.js   (keys records by local_id only)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3456);
const BUG = process.env.MOCK_BUG || '';
const MAX_RECORDS_PER_BATCH = Number(process.env.MAX_RECORDS_PER_BATCH || 100);
const RATE_LIMIT_PER_DEVICE = Number(process.env.RATE_LIMIT_PER_DEVICE || 5); // requests / second / device
const MAX_IN_FLIGHT = Number(process.env.MAX_IN_FLIGHT || 50);                 // global concurrent syncs
const PROCESSING_DELAY_MS = Number(process.env.PROCESSING_DELAY_MS || 15);    // simulates DB latency

const ROOT = path.resolve(__dirname, '..');
const WEB_DIR = path.join(ROOT, 'web');
const SCHEMA_DIR = path.join(ROOT, 'schema');

// ---------------- in-memory "database" ----------------
let db;
function reset() {
  db = {
    surveys: new Map(),        // server_id -> stored record
    byClientKey: new Map(),    // `${device_id}|${client_uuid}` -> server_id
    byLocalIdBug: new Map(),   // only used in MOCK_BUG=overwrite
    byEntity: new Map(),       // normalised entity key -> [server_id]
    idempotency: new Map(),    // Idempotency-Key -> { status, body }
    rate: new Map(),           // device_id -> [timestamps]
    seq: 0,
  };
}
reset();
let inFlight = 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const normalise = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const hashPayload = obj => crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(data);
}

function readBody(req, limitBytes = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limitBytes) { reject(Object.assign(new Error('too large'), { code: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function rateLimited(deviceId) {
  const now = Date.now();
  const hits = (db.rate.get(deviceId) || []).filter(t => now - t < 1000);
  hits.push(now);
  db.rate.set(deviceId, hits);
  return hits.length > RATE_LIMIT_PER_DEVICE;
}

function validateBatch(body) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) return ['body must be a JSON object'];
  if (!body.device_id || typeof body.device_id !== 'string') errors.push('device_id is required');
  if (!body.user_id || typeof body.user_id !== 'string') errors.push('user_id is required');
  if (!Array.isArray(body.records) || body.records.length === 0) errors.push('records must be a non-empty array');
  else body.records.forEach((r, i) => {
    if (!r || typeof r !== 'object') { errors.push(`records[${i}] must be an object`); return; }
    if (!r.local_id) errors.push(`records[${i}].local_id is required`);
    if (!r.client_uuid) errors.push(`records[${i}].client_uuid is required`);
    else if (!/^[0-9a-f-]{36}$/i.test(r.client_uuid)) errors.push(`records[${i}].client_uuid must be a UUID`);
    if (!r.survey_id) errors.push(`records[${i}].survey_id is required`);
    if (!r.answers || typeof r.answers !== 'object') errors.push(`records[${i}].answers must be an object`);
    if (!r.collected_at || isNaN(Date.parse(r.collected_at))) errors.push(`records[${i}].collected_at must be an ISO date`);
  });
  return errors;
}

// Store ONE record. Runs synchronously (no await) so check-then-insert is atomic.
function storeRecord(batch, rec) {
  const payloadHash = hashPayload({ answers: rec.answers, entity: rec.entity || null, survey_id: rec.survey_id });

  if (BUG === 'overwrite') {
    // Deliberate bug: identity = local_id only. Pooja's School_1 overwrites Ankit's.
    const existing = db.byLocalIdBug.get(rec.local_id);
    const server_id = existing || `SRV-${++db.seq}`;
    db.byLocalIdBug.set(rec.local_id, server_id);
    db.surveys.set(server_id, { server_id, device_id: batch.device_id, user_id: batch.user_id, ...rec, payload_hash: payloadHash, flags: [] });
    return { local_id: rec.local_id, client_uuid: rec.client_uuid, server_id, status: existing ? 'updated' : 'created' };
  }

  const key = `${batch.device_id}|${rec.client_uuid}`;
  const existingId = db.byClientKey.get(key);
  if (existingId) {
    const existing = db.surveys.get(existingId);
    if (existing.payload_hash === payloadHash) {
      return { local_id: rec.local_id, client_uuid: rec.client_uuid, server_id: existingId, status: 'already_synced' };
    }
    return { local_id: rec.local_id, client_uuid: rec.client_uuid, server_id: existingId, status: 'conflict',
             error: 'Record already synced with different content; send an explicit edit instead of overwriting' };
  }

  const server_id = `SRV-${++db.seq}`;
  const flags = [];
  let matched = [];
  if (rec.entity && rec.entity.name) {
    const entityKey = `${rec.entity_type || 'entity'}|${normalise(rec.entity.name)}|${normalise(rec.entity.village_code)}`;
    matched = (db.byEntity.get(entityKey) || []).filter(id => db.surveys.get(id).device_id !== batch.device_id);
    if (matched.length) flags.push('possible_duplicate');
    db.byEntity.set(entityKey, [...(db.byEntity.get(entityKey) || []), server_id]);
  }
  db.surveys.set(server_id, {
    server_id, device_id: batch.device_id, user_id: batch.user_id, ...rec,
    payload_hash: payloadHash, flags, received_at: new Date().toISOString(),
  });
  db.byClientKey.set(key, server_id);
  const result = { local_id: rec.local_id, client_uuid: rec.client_uuid, server_id, status: 'created' };
  if (matched.length) { result.status = 'created_possible_duplicate'; result.possible_duplicate_of = matched; }
  return result;
}

async function handleSync(req, res) {
  const idemKey = req.headers['idempotency-key'];

  if (inFlight >= MAX_IN_FLIGHT) return send(res, 503, { error: 'Server busy, retry later' }, { 'Retry-After': '2' });
  inFlight++;
  try {
    let raw;
    try { raw = await readBody(req); } catch (e) { return send(res, 413, { error: 'Payload too large' }); }

    // Idempotency-Key is bound to the request body: same key + same body -> replay,
    // same key + different body -> 422 (a client bug; never answer with a stale response)
    const bodyHash = crypto.createHash('sha256').update(raw).digest('hex');
    if (idemKey && db.idempotency.has(idemKey)) {
      const saved = db.idempotency.get(idemKey);
      if (saved.bodyHash !== bodyHash) return send(res, 422, { error: 'Idempotency-Key was already used with a different request body' });
      return send(res, saved.status, saved.body, { 'Idempotent-Replay': 'true' });
    }
    let body;
    try { body = JSON.parse(raw); } catch { return send(res, 400, { error: 'Invalid JSON' }); }

    const errors = validateBatch(body);
    if (errors.length) return send(res, 400, { error: 'Validation failed', details: errors });
    if (body.records.length > MAX_RECORDS_PER_BATCH) {
      return send(res, 413, { error: `Max ${MAX_RECORDS_PER_BATCH} records per batch` });
    }
    if (rateLimited(body.device_id)) return send(res, 429, { error: 'Too many requests' }, { 'Retry-After': '1' });

    await sleep(PROCESSING_DELAY_MS * Math.random()); // simulated DB latency -> real interleaving

    // Each record is processed independently and gets its own status. Node is single-threaded and
    // storeRecord() is synchronous, so each check-then-insert can't interleave with another request.
    // (A real backend needs a DB unique constraint on (device_id, client_uuid) for the same guarantee.)
    const results = body.records.map(r => storeRecord(body, r));
    const conflicts = results.filter(r => r.status === 'conflict').length;
    // 200 = all ok, 409 = every record conflicted, 207 = mixed (read per-record statuses)
    const status = conflicts === 0 ? 200 : conflicts === results.length ? 409 : 207;
    const response = { batch_id: body.batch_id || null, device_id: body.device_id, results };
    if (idemKey) db.idempotency.set(idemKey, { status, body: response, bodyHash });
    return send(res, status, response);
  } finally {
    inFlight--;
  }
}

function serveFile(res, file, type) {
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'POST' && url.pathname === '/sync-survey') return await handleSync(req, res);
    if (req.method === 'POST' && url.pathname === '/__reset') { reset(); return send(res, 200, { ok: true }); }
    if (req.method === 'GET' && url.pathname === '/surveys') {
      let list = [...db.surveys.values()];
      for (const f of ['local_id', 'device_id', 'user_id']) {
        if (url.searchParams.get(f)) list = list.filter(s => s[f] === url.searchParams.get(f));
      }
      return send(res, 200, { count: list.length, items: list });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/surveys/')) {
      const rec = db.surveys.get(decodeURIComponent(url.pathname.split('/')[2]));
      return rec ? send(res, 200, rec) : send(res, 404, { error: 'Not found' });
    }
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, bug: BUG || null });

    // static: web form + schemas
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return serveFile(res, path.join(WEB_DIR, 'index.html'), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname.startsWith('/web/')) {
      const f = path.join(WEB_DIR, path.basename(url.pathname));
      const type = f.endsWith('.js') ? 'application/javascript' : f.endsWith('.css') ? 'text/css' : 'text/html';
      return serveFile(res, f, type);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/schema/')) {
      // e.g. /schema/sample-survey-schema.json or /schema/provided/3.Sample_Survey_Schema.json
      const file = path.resolve(SCHEMA_DIR, decodeURIComponent(url.pathname.slice('/schema/'.length)));
      if (!file.startsWith(SCHEMA_DIR + path.sep)) return send(res, 400, { error: 'Bad path' }); // no ../ escapes
      return serveFile(res, file, 'application/json');
    }
    return send(res, 404, { error: 'Not found' });
  } catch (e) {
    return send(res, 500, { error: 'Internal error', message: e.message });
  }
});

server.listen(PORT, () => console.log(`Mock CAPI server on http://localhost:${PORT}${BUG ? ` (BUG MODE: ${BUG})` : ''}`));
