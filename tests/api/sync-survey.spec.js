// @ts-check
/**
 * Scenario A - Offline sync & data collision:  POST /sync-survey
 *
 * Ankit and Pooja both register "Govt Primary School" offline. Both phones give it the
 * local ID "School_1". At 5 PM both phones sync at the same moment.
 *
 * What must be true:
 *   - neither survey overwrites the other (two server records, both intact)
 *   - the server can tell the two records apart even though local_id is the same
 *   - retries after a dropped connection never create duplicates
 *   - the server flags the "same school twice" for review instead of guessing
 *   - under load the server sheds traffic (429/503 + Retry-After), it never loses data or 500s
 *
 * Run against a deliberately buggy server (keys by local_id) to see these tests fail:
 *   npm run test:buggy
 */
const { test, expect } = require('@playwright/test');
const crypto = require('crypto');
const { makeRecord, makeBatch, resetServer, storedByLocalId, syncWithRetry } = require('./helpers');

test.beforeEach(async ({ request }) => { await resetServer(request); });

test.describe('A1. Duplicate local IDs from different devices', () => {
  test('Ankit and Pooja both sync School_1 -> two separate server records, nothing overwritten', async ({ request }) => {
    const ankitRec = makeRecord({ answers: { has_toilet: 'yes', students_count: 120, teachers_count: 4 }, collected_at: '2026-10-23T10:00:00+05:30' });
    const poojaRec = makeRecord({ answers: { has_toilet: 'no', students_count: 118, teachers_count: 3 }, collected_at: '2026-10-23T11:00:00+05:30' });

    const r1 = await request.post('/sync-survey', { data: makeBatch('device-ankit', 'ankit', [ankitRec]) });
    const r2 = await request.post('/sync-survey', { data: makeBatch('device-pooja', 'pooja', [poojaRec]) });
    expect(r1.status()).toBe(200);
    expect(r2.status()).toBe(200);

    const id1 = (await r1.json()).results[0].server_id;
    const id2 = (await r2.json()).results[0].server_id;
    expect(id1).toBeTruthy();
    expect(id2).not.toBe(id1); // different global IDs for the same local ID

    const stored = await storedByLocalId(request, 'School_1');
    expect(stored).toHaveLength(2);
    // Each worker's answers are exactly what they collected - no overwrite, no merge
    expect(stored.find(s => s.user_id === 'ankit').answers).toEqual(ankitRec.answers);
    expect(stored.find(s => s.user_id === 'pooja').answers).toEqual(poojaRec.answers);
  });

  test('both devices sync at the exact same moment (race) -> still two intact records', async ({ request }) => {
    // Repeat to give a race condition many chances to show up
    for (let i = 0; i < 25; i++) {
      await resetServer(request);
      const a = makeRecord({ answers: { students_count: 100 + i } });
      const p = makeRecord({ answers: { students_count: 200 + i } });
      const [ra, rp] = await Promise.all([
        request.post('/sync-survey', { data: makeBatch(`device-ankit-${i}`, 'ankit', [a]) }),
        request.post('/sync-survey', { data: makeBatch(`device-pooja-${i}`, 'pooja', [p]) }),
      ]);
      expect(ra.status()).toBe(200);
      expect(rp.status()).toBe(200);

      const stored = await storedByLocalId(request, 'School_1');
      expect(stored, `iteration ${i}`).toHaveLength(2);
      expect(stored.map(s => s.answers.students_count).sort()).toEqual([100 + i, 200 + i]);
    }
  });

  test('same real school registered by two workers is flagged as possible duplicate, not merged', async ({ request }) => {
    await request.post('/sync-survey', { data: makeBatch('device-ankit', 'ankit', [makeRecord()]) });
    // Pooja typed the name slightly differently - normalisation should still match
    const res = await request.post('/sync-survey', {
      data: makeBatch('device-pooja', 'pooja', [makeRecord({ entity: { name: 'govt. primary  school', village_code: 'VIL-001' } })]),
    });
    const result = (await res.json()).results[0];
    expect(result.status).toBe('created_possible_duplicate');
    expect(result.possible_duplicate_of).toHaveLength(1);

    const stored = await storedByLocalId(request, 'School_1');
    expect(stored).toHaveLength(2);                                   // both kept
    expect(stored.find(s => s.user_id === 'pooja').flags).toContain('possible_duplicate');
    expect(stored.find(s => s.user_id === 'ankit').flags).not.toContain('possible_duplicate');
  });

  test('same school name in a DIFFERENT village is not flagged', async ({ request }) => {
    await request.post('/sync-survey', { data: makeBatch('device-ankit', 'ankit', [makeRecord()]) });
    const res = await request.post('/sync-survey', {
      data: makeBatch('device-pooja', 'pooja', [makeRecord({ entity: { name: 'Govt Primary School', village_code: 'VIL-999' } })]),
    });
    expect((await res.json()).results[0].status).toBe('created');
  });

  test('same device re-uses local ID after app reinstall -> new client_uuid means a new record', async ({ request }) => {
    const before = makeRecord({ answers: { students_count: 50 } });
    const afterReinstall = makeRecord({ answers: { students_count: 60 } }); // local counter restarted at School_1
    await request.post('/sync-survey', { data: makeBatch('device-ankit', 'ankit', [before]) });
    await request.post('/sync-survey', { data: makeBatch('device-ankit', 'ankit', [afterReinstall]) });
    const stored = await storedByLocalId(request, 'School_1');
    expect(stored).toHaveLength(2);
    expect(stored.map(s => s.answers.students_count).sort()).toEqual([50, 60]);
  });
});

test.describe('A2. Retries and idempotency (network dropped mid-sync)', () => {
  test('re-sending the same batch does not create a duplicate and returns the same server_id', async ({ request }) => {
    const batch = makeBatch('device-ankit', 'ankit', [makeRecord()]);
    const first = await (await request.post('/sync-survey', { data: batch })).json();
    // The phone never received the response (2G dropped) so WorkManager retries the whole batch
    const retry = await request.post('/sync-survey', { data: batch });
    expect(retry.status()).toBe(200);
    const second = await retry.json();
    expect(second.results[0].status).toBe('already_synced');
    expect(second.results[0].server_id).toBe(first.results[0].server_id);
    expect(await storedByLocalId(request, 'School_1')).toHaveLength(1);
  });

  test('Idempotency-Key header replays the exact original response', async ({ request }) => {
    const key = crypto.randomUUID();
    const batch = makeBatch('device-ankit', 'ankit', [makeRecord()]);
    const r1 = await request.post('/sync-survey', { data: batch, headers: { 'Idempotency-Key': key } });
    const r2 = await request.post('/sync-survey', { data: batch, headers: { 'Idempotency-Key': key } });
    expect(r2.status()).toBe(r1.status());
    expect(await r2.json()).toEqual(await r1.json());
    expect(r2.headers()['idempotent-replay']).toBe('true');
  });

  test('re-using an Idempotency-Key with a DIFFERENT body is rejected (422), not answered with a stale replay', async ({ request }) => {
    const key = crypto.randomUUID();
    await request.post('/sync-survey', { data: makeBatch('device-ankit', 'ankit', [makeRecord()]), headers: { 'Idempotency-Key': key } });
    const other = makeBatch('device-ankit', 'ankit', [makeRecord({ local_id: 'School_2' })]);
    const res = await request.post('/sync-survey', { data: other, headers: { 'Idempotency-Key': key } });
    expect(res.status()).toBe(422);
    expect(await storedByLocalId(request, 'School_2')).toHaveLength(0);
  });

  test('batch with one conflicting and one new record -> 207 with per-record status; new record saved, conflict not applied', async ({ request }) => {
    const rec = makeRecord({ answers: { students_count: 120 } });
    await request.post('/sync-survey', { data: makeBatch('device-ankit', 'ankit', [rec]) });
    const changed = { ...rec, answers: { students_count: 999 } };
    const fresh = makeRecord({ local_id: 'School_2', entity: { name: 'Anganwadi Centre', village_code: 'VIL-001' } });
    const res = await request.post('/sync-survey', { data: makeBatch('device-ankit', 'ankit', [changed, fresh]) });
    expect(res.status()).toBe(207);
    expect((await res.json()).results.map(r => r.status)).toEqual(['conflict', 'created']);
    expect((await storedByLocalId(request, 'School_1'))[0].answers.students_count).toBe(120);
    expect(await storedByLocalId(request, 'School_2')).toHaveLength(1);
  });

  test('same client_uuid with different answers is rejected (409), original data kept', async ({ request }) => {
    const rec = makeRecord({ answers: { students_count: 120 } });
    await request.post('/sync-survey', { data: makeBatch('device-ankit', 'ankit', [rec]) });
    const tampered = { ...rec, answers: { students_count: 999 } };
    const res = await request.post('/sync-survey', { data: makeBatch('device-ankit', 'ankit', [tampered]) });
    expect(res.status()).toBe(409);
    expect((await res.json()).results[0].status).toBe('conflict');
    const stored = await storedByLocalId(request, 'School_1');
    expect(stored).toHaveLength(1);
    expect(stored[0].answers.students_count).toBe(120);
  });

  test('partial retry: batch with one synced + one new record creates only the new one', async ({ request }) => {
    const r1 = makeRecord({ local_id: 'School_1' });
    const r2 = makeRecord({ local_id: 'School_2', entity: { name: 'Anganwadi Centre', village_code: 'VIL-001' } });
    await request.post('/sync-survey', { data: makeBatch('device-ankit', 'ankit', [r1]) });
    const res = await request.post('/sync-survey', { data: makeBatch('device-ankit', 'ankit', [r1, r2]) });
    const statuses = (await res.json()).results.map(r => r.status);
    expect(statuses).toEqual(['already_synced', 'created']);
    const all = await (await request.get('/surveys?device_id=device-ankit')).json();
    expect(all.count).toBe(2);
  });
});

test.describe('A3. Payload validation', () => {
  const bad = [
    { name: 'missing device_id', mutate: b => { delete b.device_id; }, error: 'device_id is required' },
    { name: 'missing user_id', mutate: b => { delete b.user_id; }, error: 'user_id is required' },
    { name: 'empty records array', mutate: b => { b.records = []; }, error: 'records must be a non-empty array' },
    { name: 'missing local_id', mutate: b => { delete b.records[0].local_id; }, error: 'records[0].local_id is required' },
    { name: 'missing client_uuid', mutate: b => { delete b.records[0].client_uuid; }, error: 'records[0].client_uuid is required' },
    { name: 'client_uuid not a UUID', mutate: b => { b.records[0].client_uuid = '123'; }, error: 'records[0].client_uuid must be a UUID' },
    { name: 'answers not an object', mutate: b => { b.records[0].answers = 'yes'; }, error: 'records[0].answers must be an object' },
    { name: 'bad collected_at date', mutate: b => { b.records[0].collected_at = 'yesterday'; }, error: 'records[0].collected_at must be an ISO date' },
  ];
  for (const c of bad) {
    test(`rejects ${c.name} with 400 and nothing is stored`, async ({ request }) => {
      const batch = makeBatch('device-ankit', 'ankit', [makeRecord()]);
      c.mutate(batch);
      const res = await request.post('/sync-survey', { data: batch });
      expect(res.status()).toBe(400);
      expect((await res.json()).details).toContain(c.error);
      expect((await (await request.get('/surveys')).json()).count).toBe(0);
    });
  }

  test('rejects malformed JSON with 400', async ({ request }) => {
    const res = await request.post('/sync-survey', { data: '{"device_id": "x", ', headers: { 'Content-Type': 'application/json' } });
    expect(res.status()).toBe(400);
  });

  test('rejects a batch over 100 records with 413 (app must chunk)', async ({ request }) => {
    const records = Array.from({ length: 101 }, (_, i) => makeRecord({ local_id: `School_${i}` }));
    const res = await request.post('/sync-survey', { data: makeBatch('device-ankit', 'ankit', records) });
    expect(res.status()).toBe(413);
  });

  test('keeps Hindi / Unicode text exactly as sent', async ({ request }) => {
    const rec = makeRecord({ entity: { name: 'सरकारी प्राथमिक विद्यालय', village_code: 'VIL-001' }, answers: { remarks: 'शौचालय नहीं है ✔' } });
    const res = await request.post('/sync-survey', { data: makeBatch('device-pooja', 'pooja', [rec]) });
    const id = (await res.json()).results[0].server_id;
    const stored = await (await request.get(`/surveys/${id}`)).json();
    expect(stored.entity.name).toBe('सरकारी प्राथमिक विद्यालय');
    expect(stored.answers.remarks).toBe('शौचालय नहीं है ✔');
  });
});

test.describe('A4. Thundering herd at 5 PM (load shedding without data loss)', () => {
  test('150 devices sync at once -> no 500s, overload answered with 429/503 + Retry-After, every record stored exactly once', async ({ request }) => {
    test.setTimeout(120_000);
    const batches = Array.from({ length: 150 }, (_, i) =>
      makeBatch(`device-${i}`, `worker-${i}`, [makeRecord({ answers: { students_count: i } })]));

    // First wave: everyone at the same instant
    const firstWave = await Promise.all(batches.map(b => request.post('/sync-survey', { data: b })));
    const codes = firstWave.map(r => r.status());
    expect(codes.filter(c => c >= 500 && c !== 503), 'no crashes').toHaveLength(0);
    for (const r of firstWave.filter(r => [429, 503].includes(r.status()))) {
      expect(r.headers()['retry-after'], 'overload responses must tell the app when to retry').toBeTruthy();
    }
    console.log(`first wave: ${codes.filter(c => c === 200).length} accepted, ${codes.filter(c => c === 503).length} shed (503)`);

    // Devices that were shed retry with backoff, like WorkManager would
    const retried = batches.filter((_, i) => [429, 503].includes(codes[i]));
    expect(retried.length, 'the burst must actually trigger load shedding, or this test proves nothing').toBeGreaterThan(0);
    const results = await Promise.all(retried.map(b => syncWithRetry(request, b)));
    for (const { res } of results) expect(res.status()).toBe(200);

    const all = await (await request.get('/surveys')).json();
    expect(all.count).toBe(150);                                           // nothing lost
    const counts = all.items.map(s => s.answers.students_count).sort((a, b) => a - b);
    expect(counts).toEqual(Array.from({ length: 150 }, (_, i) => i));       // nothing duplicated
  });

  test('one device hammering the endpoint is rate limited (429 + Retry-After)', async ({ request }) => {
    const sends = Array.from({ length: 12 }, () =>
      request.post('/sync-survey', { data: makeBatch('device-stuck-loop', 'ankit', [makeRecord()]) }));
    const res = await Promise.all(sends);
    const limited = res.filter(r => r.status() === 429);
    expect(limited.length).toBeGreaterThan(0);
    expect(limited[0].headers()['retry-after']).toBeTruthy();
  });
});
