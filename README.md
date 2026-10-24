# QA Take-Home – CAPI Survey Builder & Offline Android App

This repo contains my hands-on automation and the written answers for all 4 parts of the assessment.

| Deliverable | Where |
|---|---|
| **Automated tests** | `tests/` – Playwright (API, web UI and unit), plus a Postman collection in `postman/` |
| **Test cases / plans** | `test-cases/*.csv` |
| **Answers to the scenario questions** | This README |
| **Reference documents (as provided)** | `docs/reference/` – assessment brief, Android App Specification, Survey Builder Tool Capabilities |

**Results:** all **211 automated tests pass**: 69 unit checks, 24 API tests, 59 web tests, and the same 59 web tests again on a small phone-sized screen. That includes 14 tests marked "known bug", which document defects in the provided schema and in the two spec documents (see [B0](#b0-what-i-found-in-the-provided-schema)). As a sanity check, `npm run verify:buggy` runs the API tests against a deliberately broken server and confirms that exactly the duplicate-ID and idempotency tests fail (10 of 24), while the validation tests still pass.

---

## Contents

- [Setup and how to run](#setup-and-how-to-run)
- [Repo structure](#repo-structure)
- [Part 1 – Scenario A: Offline sync and data collision](#scenario-a-offline-sync-and-data-collision)
- [Part 1 – Scenario B: Dynamic form rendering and regression](#scenario-b-dynamic-form-rendering-and-regression)
- [Part 1 – Scenario C: Room and WorkManager inspection](#scenario-c-offline-sync-and-state-management-room-and-workmanager)
- [Part 2 – Scenario D: Crash on 4 GB RAM phones](#scenario-d-the-edge-case-device-constraints)
- [Part 2 – Scenario E: HFC engine test plan](#scenario-e-the-hfc-engine)
- [Part 3 – QA process and AI](#part-3-qa-process-and-ai-integration)
- [Part 4 – UI/UX for field workers](#part-4-uiux-and-user-centric-qa)
- [Assumptions](#assumptions)

---

## Setup and how to run

Requirements: Node.js 18+ (tested with Node 20/24).

```bash
npm install
npx playwright install chromium

npm test                 # everything: unit + API + web (desktop and small-phone viewport)
npm run test:api         # Scenario A only
npm run test:web         # Scenario B only
npx playwright test --project=unit   # schema contract + HFC engine (no browser, ~2 s)
npm run test:buggy       # runs the API tests against a deliberately broken server -> they SHOULD fail
npm run verify:buggy     # same, but checks that the RIGHT tests fail (used in CI)
npm run report           # open the HTML report
npm run server           # start the mock backend + web form on http://localhost:3456
```

Playwright starts the mock server automatically, so no separate step is needed.

**Postman / Newman** (an alternative way to run Scenario A, for developers who prefer Postman):

```bash
npm run server
npm run test:postman     # = npx newman run postman/sync-survey.postman_collection.json
```

**CI:** `.github/workflows/tests.yml` runs the full suite on every push. It also checks that the suite still catches the overwrite bug.

## Repo structure

```
mock-server/server.js          Mock backend: POST /sync-survey + serves the web form
web/                           Schema-driven survey form (renders any schema at runtime)
  logic.js                     Skip logic, HFC rules and schema contract - shared by the form AND the tests
  builder-format.js            Reads the Survey Builder format + audits it for defects
schema/provided/3.Sample_Survey_Schema.json   The PROVIDED schema, byte-for-byte (invalid JSON - see PS-01)
schema/sample-survey-schema.json     Same file with only the missing comma added, so it can be rendered
schema/household-survey.schema.json  My extra sample: chained/numeric/multi-select rules, a roster, HFC rules
schema/android-spec-hfc.json   Fixture built from the Android spec's HFC example (q_3 > 16) + block / flag_silently rules
docs/reference/                The assessment brief and the two reference specs, exactly as provided
tests/api/sync-survey.spec.js  Scenario A - 24 API tests
scripts/verify-buggy-server.js Proves the API tests catch the overwrite bug (used in CI)
tests/web/skip-logic.spec.js   Scenario B - hand-written skip logic, roster and HFC UI tests
tests/web/provided-schema.spec.js  Scenario B on the PROVIDED schema: hobby test + generated tests for all 3 surveys
tests/web/schema-driven.spec.js  Scenario B - tests GENERATED from the schema
tests/web/android-spec-hfc.spec.js  Android spec + Builder spec behaviour: HFC actions, range-before-HFC, display order
tests/unit/provided-schema-audit.spec.js  Contract audit of the provided schema (22 rules; known bugs PS-01..PS-09, PS-19, PS-20)
tests/unit/reference-specs.spec.js  Spec documents vs. schema consistency (known bugs PS-21..PS-23)
tests/unit/schema-contract.spec.js  Scenario B - catches broken schemas before the app sees them
tests/unit/hfc-engine.spec.js  Scenario E - HFC rules, driven by the CSV test plan
test-cases/                    Test plans (CSV): sync API, dynamic forms, Android offline sync, HFC, field UX checklist,
                               and provided-schema-defects.csv (23 findings in the schema and the specs)
postman/                       Postman collection for Scenario A
.github/workflows/tests.yml    CI
```

---

# Part 1 – Hands-on technical inspection and automation

## Scenario A: Offline sync and data collision

### A1. API automation – handling duplicate local IDs

**The core idea.** `local_id` ("School_1") is only unique on one phone. The server must never use it as the identity of a record. In my design:

- **Each device generates a `client_uuid`** when the record is created offline. The record's identity on the server is `device_id + client_uuid`, so Ankit's School_1 and Pooja's School_1 are different records.
- **Retries are safe.** Re-sending the same record returns the same `server_id` (`already_synced`). An `Idempotency-Key` header replays the original response.
- **Nothing is silently overwritten.** The same `client_uuid` with different answers gets a 409. An edit must be sent as an explicit edit.
- **The same real school is flagged, not guessed.** Two workers registering the same school (normalised name + village) produces two records, and the second is flagged `possible_duplicate` for a supervisor to merge.
- **The server sheds load instead of falling over.** A per-device rate limit and a global in-flight cap return 429/503 with `Retry-After`, so the "50,000 devices at 5 PM" spike becomes a spread-out queue.

**Request the tests send** (one WorkManager run = one batch):

```json
POST /sync-survey
{
  "batch_id": "6f1c...",
  "device_id": "device-ankit",
  "user_id": "ankit",
  "records": [{
    "local_id": "School_1",
    "client_uuid": "0e7d4c5a-...",
    "survey_id": "school_survey_v1",
    "schema_version": 3,
    "entity_type": "school",
    "entity": { "name": "Govt Primary School", "village_code": "VIL-001" },
    "answers": { "students_count": 120 },
    "collected_at": "2026-10-23T10:00:00+05:30"
  }]
}
```

**What the 24 tests cover** (`tests/api/sync-survey.spec.js`; full list in `test-cases/scenario-a-sync-api-test-cases.csv`):

| Group | Tests |
|---|---|
| A1 Duplicate local IDs | Ankit + Pooja both send School_1 → 2 records, both intact · **same instant, repeated 25 times** to expose races · same school flagged as possible duplicate · same name in a different village not flagged · local ID reused after app reinstall |
| A2 Retries and idempotency | Whole batch retried after a lost response · Idempotency-Key replay · same key with a different body → 422 · same `client_uuid` with changed answers → 409, original kept · mixed batch (one conflict, one new) → 207 with a status per record · partial batch retry |
| A3 Validation | 8 data-driven bad payloads → 400 with a field-level message and nothing stored · malformed JSON · >100 records → 413 · Hindi text preserved |
| A4 Load | 150 devices at once → no 500s, load is actually shed and answered with `Retry-After`, after retries **all 150 stored exactly once** · one looping device gets 429 |

**Proving the tests work.** `npm run verify:buggy` starts the server with `MOCK_BUG=overwrite`, which keys records by `local_id`: exactly the bug the scenario describes. It then checks that the right tests fail: 10 of 24, including the core "Ankit and Pooja" test, the idempotency tests and the load test. The validation tests must still pass, which shows the server did start correctly. A test suite that can't fail is worthless, so this runs in CI too.

**Limits of the mock, stated honestly.** The mock runs on single-threaded Node, so the "same instant" race test can't really expose a race here. It earns its keep against a real, multi-threaded backend with a database. There, the same guarantee needs a **unique constraint on (`device_id`, `client_uuid`)** in the database, not just application code. Against staging I'd point `baseURL` at it and keep the same tests.

**Testing the 50,000-device spike for real.** The 150-request test checks behaviour under overload (no data loss, `Retry-After` honoured). Capacity needs a proper load test against staging:

- **Tool:** k6 (or Gatling), with a profile of a sharp ramp from 0 to 50,000 virtual devices in 2–5 minutes around "5 PM", then a soak.
- **Targets agreed upfront:** for example p95 latency under 2 s, a 5xx rate under 0.1%, and **zero lost or duplicated records** (counted in the database afterwards).
- **Client side, which matters as much as the server:** the app should spread its own load with a random initial delay, exponential backoff with jitter, honour `Retry-After`, and send batches in chunks. I'd verify this on the device, because 50,000 phones retrying in lockstep is what turns a slow server into an outage.
- **Server protections to verify:** a queue in front of the database writes, autoscaling, per-device rate limits, and a 503 + `Retry-After` response instead of timeouts.

### A2. Testing background sync under poor networks (e.g. the network drops at 99% of a photo upload)

**What "correct" means**

1. The survey stays **pending** until the server confirms both the data and the photo.
2. The retry **resumes or restarts** the photo and never leaves a half photo marked as done.
3. A retry never creates a duplicate survey or photo.
4. Retries back off. No endless loop draining the battery or the user's data pack.
5. The user sees a clear "waiting to sync" state.

**Tools and how I'd use them**

| Tool | Use |
|---|---|
| **Charles Proxy / Proxyman** | Install its CA certificate on the device. The debug build must trust user certificates via `network_security_config` debug-overrides. Set the device proxy with `adb shell settings put global http_proxy <laptop-ip>:8888`, and remove it afterwards with `adb shell settings put global http_proxy :0` (otherwise the phone loses its internet). **Throttling** set to a 2G profile (≈50 kbps, 500 ms latency, packet loss). **Breakpoints** to pause and abort a request. **Rewrite** to return 500/503/timeouts. |
| **mitmproxy** (for "exactly 99%") | A small addon that **streams** the upload body (in the `requestheaders` hook, set `flow.request.stream` to a function; by default mitmproxy buffers the whole body first, so a mid-upload cut would never reach the server). The function counts bytes and stops forwarding once 99% of `Content-Length` has passed, then logs a marker line. This is deterministic and repeatable, unlike unplugging Wi-Fi by hand. Only one proxy can be the device's proxy, so either chain them (Charles → *External Proxy* → mitmproxy) or do the throttling in mitmproxy too. |
| **ADB network control** | `adb shell svc wifi disable` / `adb shell svc data disable` / `adb shell cmd connectivity airplane-mode enable` (Android 11+). Scripted with a delay that matches the throttled upload time. |
| **Android Emulator** | `emulator -avd Pixel_4GB -netspeed gsm -netdelay gprs`, or extended controls → Cellular, to change signal strength mid-upload. |
| **Linux `tc netem`** on a Wi-Fi hotspot (laptop or Raspberry Pi) | Real packet loss and jitter for a physical device. Note that `netem` on the hotspot's `wlan0` only shapes traffic going **to** the phone. To slow the phone's **upload**, apply it on the hotspot's internet-facing interface (e.g. `tc qdisc add dev eth0 root netem delay 800ms 300ms loss 10%`), or redirect `wlan0` ingress through an `ifb` device. |
| **logcat + Room inspection** | `adb logcat -s WM-WorkerWrapper` shows the worker result (`RETRY` / `SUCCESS`). Pull the DB (Scenario C) to confirm the row is still `PENDING`. |
| **Server side** | Check that the storage bucket holds no partial photo object without a completed survey, and that there are no duplicates after the retry. |

**Test steps (photo drop at 99%)**

1. Airplane mode on, then complete a survey with a 1 MB photo (a typical compressed field photo).
2. Throttle the upload to about **100 kbps** (≈12 KB/s), so the upload takes about 80 s: slow enough to watch, short enough to repeat. Start the mitmproxy "stop at 99%" addon.
3. Airplane mode off. WorkManager starts the sync.
4. When the addon logs its marker, a small script runs `adb shell svc data disable` (or `svc wifi disable`). The phone sees the connection die at 99%. Check: the survey is still pending in Room, the WorkManager job is `ENQUEUED` for a retry (see Scenario C), and the UI shows "waiting".
5. Restore the network. Check: one retry, with backoff, and the server ends with **one** survey and **one** complete photo, whose checksum matches the file on the device.
6. **The realistic worst case:** a 3–5 MB photo on real 2G (≈30 kbps) takes 15–20 minutes. A normal WorkManager worker is **stopped after 10 minutes**, so the upload can never finish and retries forever. This is a real risk to test: the app needs chunked or resumable uploads, or a long-running foreground worker (`setForeground()`), and photo compression before upload.

I'd repeat this with the cut **before** the response arrives (the server saved it, but the phone never heard back) to prove idempotency, and with the app killed mid-upload (`adb shell am kill <pkg>`).

---

## Scenario B: Dynamic form rendering and regression

### B0. What I found in the provided schema

Before writing UI tests I audited the provided `3.Sample_Survey_Schema.json` against the two reference documents (the **Survey Builder Tool Capabilities** spec, which defines the data model, input types, visibility conditions and HFC actions, and the **Android App Specification**, which defines what the app must parse and how it displays it). The schema is the real input to every screen. `web/builder-format.js` checks it automatically, and **23 findings** are logged with evidence, field impact and a suggested fix in `test-cases/provided-schema-defects.csv`. The most important ones:

| ID | Severity | Defect | Why it matters in the field |
|---|---|---|---|
| **PS-01** | Critical | **The file is not valid JSON**: a comma is missing between the two HFC conditions (line 158) | The app can't parse the file at all, so **none of the 3 surveys** would download. One comma blocks everything. |
| **PS-02** | High | HFC conditions use the key `questioID` instead of `attr`, the key both specs use (Builder §11, Android spec §3) | The rule can't find its question and silently never runs |
| **PS-03** | High | The sleep HFC rule **can never fire**: it needs "slept well = Yes", but the hours question (q_3) is only visible when "slept well = No" | The exact data-quality check from the brief (sleeps well but < 6 hours) is dead |
| **PS-04 / 05** | High / Medium | Surveys have **no id and no version** | Synced answers can't be linked to the exact form version they were collected on |
| **PS-06 / 07** | Medium | Numbers stored as strings (`"min": "0"`, `"val": "6"`); `validationRules` is sometimes an object, sometimes an array | Text comparison makes `"10" < "6"` true; typed parsers in the app can crash |
| **PS-09** | Medium | The grade question has an "Other" option with no "please specify" follow-up | The real answer is lost |
| **PS-20** | High | The schema doesn't follow the Builder's documented model: `questions` instead of `items[]`, a `sectionChecklist` string instead of `checklistGuide[]`, `hintText`/`checklistGuide` as strings instead of lists, `validationRules {type,min,max}` instead of `validations[{type,value,message}]`, no `language` (PS-19) | Either the builder exports something other than what it documents, or the app parses a format the builder won't produce. **Question for the team: which one is the contract?** |
| **PS-21** | High | The Android spec's example rule `hfc_sleep_plausible` is `q_3 > 16` ("unusually **high**"); the schema's rule with the **same id** is `q_2 = Yes AND q_3 < 6` ("unusually **low**") | Developers build and test against the spec example, so the real rule (already unreachable, PS-03) is never what gets tested |
| PS-22, 23 | Low | Builder spec says "**Twenty** input types" but lists 13; its HFC example has `"op": " "` | Docs that people copy from must be correct |
| PS-11, 12, 15 | Medium / Low | Follow-up questions are never required; labels contain enumerator notes like "(If Yes)"; options have no separate stored value | Missing reasons; confusing screens; translating a label would break skip logic |

**How the tests handle these.** The original file is kept byte-for-byte in `schema/provided/`. A copy with **only the comma added** (`schema/sample-survey-schema.json`) is what the form renders, and a test proves the two differ by exactly one character. Every contract rule is a test (`tests/unit/provided-schema-audit.spec.js`). Rules the file currently breaks are marked `test.fail()` with their bug ID: they count as "expected failure" today. When the builder team fixes the bug, the test starts passing and Playwright flags it, so the annotation gets removed. The bugs stay visible without turning CI red. `tests/unit/reference-specs.spec.js` does the same for the documents: it extracts the HFC examples from the two HTML specs (kept in `docs/reference/`) and checks them against the schema and the engine. There's also a UI test that loads the **original** broken file and checks that the form shows a clear error message instead of a blank or half-built screen.

### B1. Web automation – the skip-logic test

`web/` holds a small form that, like the Android app, **renders itself at runtime from a JSON schema**. It reads the Survey Builder format directly (`/?schema=sample-survey-schema.json&survey=3`). The test the brief asks for runs on the **provided** schema, survey 3 "Student Interests & Hobbies" (`tests/web/provided-schema.spec.js`):

```js
test('"What is your hobby?" becomes visible when "Do you have a hobby?" = Yes', async ({ page }) => {
  const hobby = page.getByLabel('What is your hobby? (If Yes)');
  await expect(hobby).toBeHidden();

  await page.getByLabel('Do you have a hobby?').selectOption('Yes');
  await expect(hobby).toBeVisible();
  await expect(hobby).toBeEditable();
});
```

On the provided schema, the suite also checks that:
- "No" keeps it hidden, and switching Yes → No → Yes clears the typed answer.
- The hidden answer is not submitted.
- Required dropdowns block submission.
- Section titles and hints from the schema are shown.
- Elements appear in the **Android spec's display order**: Survey Title > Section Title > Section Checklist > Question Text > Question Hint > Input > Checklist Guide (`tests/web/android-spec-hfc.spec.js`).
- `visibilityLogic.enabled: false` means "always visible", and the `range` validation (0–24) runs **before** any HFC.

A test is also **generated for every one of the 8 skip rules across all 3 surveys** (shown for the matching answer, hidden for another). One more test shows defect PS-03 from the user's side: no combination of answers ever triggers the sleep re-ask.

The provided schema only uses simple "equals" rules. To cover what the builder supports (the Builder spec lists 13 input types, seven visibility conditions and rosters), I added my own sample, `schema/household-survey.schema.json`. `tests/web/skip-logic.spec.js` runs on it and checks the things that actually break in production:

- A hidden answer is **cleared** and **not submitted**.
- A **hidden required** question doesn't block submit, and a visible one does.
- **Chained** rules cascade (hide the parent and the whole chain hides).
- **Numeric boundaries** work (age 17, 18, 19 and 0 against `age >= 18`).
- A **multi-select** "Other → specify" rule works.
- **Rosters:** one block per household member, skip logic scoped to each member, and removing a member removes their data.
- The **HFC** re-ask flow in the UI.

The same suite runs a second time on a **small Android-sized viewport** (`web-mobile` project).

### B2. Designing a regression suite when screens are generated from JSON

When the UI is generated, **the schema is the real input**, so I test in layers and let the schema drive the tests.

```
1. Schema contract (milliseconds)    -> is the JSON valid for the app?
2. Logic engine (milliseconds)       -> do skip logic / HFC / validation evaluate correctly?
3. Generated UI tests (minutes)      -> for every rule in the schema: shown when true, hidden when false
4. Golden schemas on real devices    -> a fixed set of "torture" forms on low-end Android
5. Manual exploratory                -> what automation can't judge
```

1. **Schema contract tests** (`tests/unit/schema-contract.spec.js`). I'd propose that every builder build validates its output before release: unique IDs, skip rules that only point to earlier questions, operators and question types the app supports, options present, roster counts valid, and HFC rules referencing real questions. I wrote **13 realistic builder bugs** as mutations, and the contract catches all of them. This is the cheapest, fastest guard against "the builder shipped a feature and broke the app".
2. **Logic-engine unit tests.** Skip logic and HFC are tested directly with data tables, with no UI needed (here `web/logic.js`). The Android app has its own Kotlin engine, so I'd run its unit tests from the **same data tables** (e.g. `test-cases/hfc-engine-test-plan.csv`). Then web and app can't silently disagree on a rule.
3. **Generated UI tests** (`tests/web/schema-driven.spec.js`). The test file reads the schema and creates two tests for every top-level skip rule (rules inside rosters are covered by the hand-written roster tests), using **boundary values** (`gte 18` → 18 shows it, 17 hides it). It also resolves chains automatically. When the builder adds a rule, coverage grows on its own. Pointing it at another schema is just `SCHEMA=my-form.json`.
4. **Golden schemas.** A versioned library of schemas that use **every input type** (all 13 in the Builder spec, including image options, Matrix and Roster), deep nesting, a roster inside conditions, 200+ questions, long Hindi labels and unusual combinations. Each builder release runs them on the Android app (Espresso/Maestro on Firebase Test Lab with a low-end device). Old schema versions stay in the library, so surveys already on phones keep working (backward compatibility).
5. **Version compatibility.** A schema produced by builder N must render in app versions N-1 and N-2 that are still in the field. Unknown types must fall back gracefully, not crash.

**Automate vs. explore**

| Automate | Leave for manual exploratory testing |
|---|---|
| Schema contract, logic engine, every skip rule (generated) | Whether a long form *feels* usable on a 5-inch screen in sunlight |
| Hidden-data clearing, required/hidden interaction, roster add/remove | Odd answer orders: jump back, change early answers, rotate the phone, interrupt with a call |
| Submission payload shape, HFC flows | Hindi/Marathi text wrapping, icons, readability for low literacy |
| Rendering every input type once per release (golden schemas) | New input types in their first release, before they're stable enough to automate |
| Performance budgets (render time of 200 questions on a low-end device) | Field testing with real enumerators |

---

## Scenario C: Offline sync and state management (Room and WorkManager)

Test cases: `test-cases/scenario-c-offline-sync-android-test-cases.csv`. I use `com.capi.app` as a placeholder package name.

### C1. Extract and inspect the Room database from an unrooted device

A **release** APK is normally `debuggable=false`, and then `run-as` is blocked by design. So the first step is choosing a route:

| Route | How | Watch out for |
|---|---|---|
| **1. Debuggable staging variant (preferred)** | Ask for a build with the same code and R8 rules but `debuggable true` and the staging API. I'd make this a standard QA build (Part 3). Then use `run-as` (below). | Not byte-for-byte the release build, so do a final smoke test on the real release APK. |
| **2. Emulator without Google Play** | Install the release APK on a "Google APIs" emulator image (not "Google Play"), which allows `adb root`. Then `adb root` and `adb pull /data/data/com.capi.app/databases/ .` directly. | No real-device quirks (OEM battery killers, real storage speed). |
| **3. `adb backup`** | Only if the manifest has `allowBackup=true`: `adb backup -f capi.ab -noapk com.capi.app`, then convert with Android Backup Extractor: `java -jar abe.jar unpack capi.ab capi.tar` and extract the tar. | Deprecated. On Android 12+, apps targeting API 31+ are excluded from `adb backup` unless debuggable. |
| **4. Re-sign the APK as debuggable** (last resort) | Decode with apktool, set `android:debuggable="true"`, rebuild and sign with a test key. | The signature changes, so the original app must be **uninstalled first, which deletes the data you wanted**. Play-delivered apps are split APKs (`adb shell pm path com.capi.app` lists several), and Google sign-in or Play Integrity may stop working. Only useful for a fresh test, not for an existing field device. |

With a debuggable build (route 1):

```bash
adb shell pm list packages | grep capi                     # confirm the package
adb shell run-as com.capi.app ls -l databases/             # e.g. capi.db, capi.db-wal, capi.db-shm

# Room uses WAL mode: recent writes may still be in the -wal file. force-stop kills the process
# (it does NOT checkpoint), which gives a consistent snapshot. Copy all three files TOGETHER;
# sqlite3 replays the WAL when it opens them (or run "PRAGMA wal_checkpoint;" locally).
adb shell am force-stop com.capi.app
for f in capi.db capi.db-wal capi.db-shm; do
  adb exec-out run-as com.capi.app cat databases/$f > $f
done

sqlite3 capi.db "PRAGMA integrity_check;"
sqlite3 capi.db ".tables"
# table/column names below are examples - read the real ones from .tables / .schema first
sqlite3 capi.db "SELECT local_id, client_uuid, sync_status, updated_at FROM surveys ORDER BY updated_at DESC LIMIT 5;"
sqlite3 capi.db "SELECT * FROM answers WHERE survey_local_id = 'School_1';"

# WorkManager keeps its own Room database - pull it too, to see the sync job's real state
# (WorkManager 2.6+ keeps it in no_backup/; older versions in databases/)
for f in androidx.work.workdb androidx.work.workdb-wal androidx.work.workdb-shm; do
  adb exec-out run-as com.capi.app cat no_backup/$f > $f
done
sqlite3 androidx.work.workdb "SELECT id, worker_class_name, state, run_attempt_count FROM WorkSpec;"
# state: 0=ENQUEUED 1=RUNNING 2=SUCCEEDED 3=FAILED 4=BLOCKED 5=CANCELLED
```

**What I check before sync:** the row exists with `sync_status = PENDING`. Every answer matches what I entered, including roster rows and photo file paths, and the photo file exists. `client_uuid` is set, and `schema_version` matches the form. Hidden answers aren't saved. The data survives `am force-stop` and `adb reboot`.

**Alternative:** Android Studio → **App Inspection → Database Inspector** shows live Room tables and lets you run queries on a debuggable app without pulling files.

### C2. Force the WorkManager sync job to run now via ADB

On Android 6+ WorkManager schedules work through `JobScheduler`, so I can find and force the job.

```bash
# 1. See the scheduled job, its constraints (e.g. CONNECTIVITY) and its id
adb shell dumpsys jobscheduler com.capi.app

# 2. Run it immediately; -f ignores unmet constraints, so I can test sync logic on demand
adb shell cmd jobscheduler run -f com.capi.app <JOB_ID>

# 3. Watch what WorkManager does
adb logcat -s WM-WorkerWrapper WM-SystemJobService WM-Processor

# WorkManager 2.4+ diagnostics: dumps all work, its state and attempt count to logcat
adb shell am broadcast -a "androidx.work.diagnostics.REQUEST_DIAGNOSTICS" -p "com.capi.app"
adb logcat -s WM-DiagnosticsWrkr
```

I'd also test the **real trigger**: `adb shell cmd connectivity airplane-mode disable`. The job must start by itself when the network constraint is met. Then the harder conditions:

```bash
# Doze: the device must think it is unplugged first
adb shell dumpsys battery unplug
adb shell dumpsys deviceidle force-idle      # sync should wait for a maintenance window, then run
adb shell dumpsys deviceidle unforce
adb shell dumpsys battery reset

# App standby bucket: how a rarely-opened app is treated
adb shell am set-standby-bucket com.capi.app restricted
```

Budget phones (Xiaomi, Vivo, Oppo, Realme) also have their own **battery-saving app killers** that can stop background work entirely, so I'd test on those brands with default settings. For the debug build I'd ask developers for a hidden "Sync now" button in developer settings, and to initialise WorkManager with `Log.VERBOSE`.

### C3. Simulate a 500 and verify the retry keeps the data

**Setup**
1. Install the Charles root certificate on the device (the debug build trusts user CAs).
2. Set the proxy: `adb shell settings put global http_proxy 192.168.1.10:8888`. Remove it when finished: `adb shell settings put global http_proxy :0`.
3. In Charles: **Tools → Rewrite** → rule on `POST */sync-survey` → *Response Status* = `500`. Or set a **Breakpoint** and edit the response by hand.

**Steps**
1. Save a survey offline. Note the row in the app's database (`PENDING`) and the sync job in `androidx.work.workdb` (`state = 0` ENQUEUED, `run_attempt_count = 0`).
2. Go online, or force the job (C2). Charles shows the request and returns 500.
3. Verify the following:
   - logcat shows `Worker result RETRY`, **not** `FAILURE`. A `FAILURE` would mean the app has given up on the data.
   - `dumpsys jobscheduler` shows the job **re-scheduled with backoff**. The exponential default is 30 s, then 60 s, and so on. Check it doesn't retry in a tight loop.
   - Re-pull both databases. The survey row is **still there** with `PENDING`, and its answers and photo are unchanged (diff against step 1). In `WorkSpec`, the job is back to `state = 0` (ENQUEUED) with `run_attempt_count = 1`. That proves a retry is scheduled, and the data is safe.
   - The UI still shows "waiting to sync".
4. Disable the rewrite rule and let the retry run. It ends `SUCCESS`, the row is `SYNCED` with a `server_id`, and the server has **exactly one** record.
5. Variations: 503 with `Retry-After` (the app should honour it), a timeout (Charles breakpoint with no response), **a 500 after the server has already saved the data** (the retry must give `already_synced`, not a duplicate), a 401 (re-login, not an endless retry), and the app killed during the retry.

---

# Part 2 – Complex scenarios and edge cases

## Scenario D: The edge-case device constraints

**Symptom:** after 3–4 offline training videos the app crashes or shows an ANR on 4 GB phones, but works on office phones. That pattern — fine at first, fails after repetition, only on low-memory devices — points to **memory growing with each video** (a leaked player, decoder or bitmaps) or **storage filling up** (an unbounded video cache). The per-app Java heap limit is similar on most phones, so the difference is mostly elsewhere. Video decoding uses **native and graphics memory**, and the system's low-memory killer (`lmkd`) steps in much earlier on a 4 GB phone that is also running other apps. An office phone with 8–12 GB has enough headroom that a slow leak never gets the app killed or stalled in a short test.

### 1. Reproduce

- **Match the field device.** Use a real 4 GB phone (ideally the same model as the field workers, from the crash reports), or an emulator AVD with `hw.ramSize=4096` (lower it to 3072 to make the problem appear faster). Check the app's heap limit: `adb shell getprop dalvik.vm.heapgrowthlimit`.
- **Match the field state.** Same videos, offline, low storage, other apps in the background (WhatsApp, camera), battery saver on.
- **Script the steps** so they repeat exactly. Use a Maestro or UI Automator flow: open the Video Hub, play video 1 to the end, Back, video 2 … video 5. Run it 5 times and record how often it fails.

### 2. Simulate low memory and low storage

```bash
# memory pressure - REAL pressure comes from less RAM (hw.ramSize) and busy background apps
# (open the camera, WhatsApp, a game), plus Developer options -> background process limit = 1-2
adb shell settings put global always_finish_activities 1         # = "Don't keep activities"

# send-trim-memory only calls the app's onTrimMemory() callback - it checks the app RELEASES
# memory when asked, it does not create pressure. (On Android 14+ only some levels are still sent.)
adb shell am send-trim-memory com.capi.app RUNNING_CRITICAL
adb shell am send-trim-memory com.capi.app UI_HIDDEN

# storage pressure
adb shell df -h /data                       # read "Avail", e.g. 3.2G free
# fill all but ~200 MB: count = (available MB - 200), e.g. 3200 - 200 = 3000
adb shell dd if=/dev/zero of=/sdcard/Download/filler.bin bs=1M count=3000
adb shell rm /sdcard/Download/filler.bin    # undo
adb shell cmd devicestoragemonitor force-low -f                         # make the OS report low storage
adb shell cmd devicestoragemonitor reset                                # undo
```

### 3. Measure while reproducing

```bash
# memory after each video - PSS should come back down when you leave the player
adb shell dumpsys meminfo com.capi.app | grep -E "TOTAL|Native Heap|Dalvik Heap|Graphics"

# crash / ANR / low-memory-killer evidence - include the system and events buffers:
# "ANR in" comes from ActivityManager (system buffer), kills are logged as am_kill (events buffer)
adb logcat -b main,system,crash,events | grep -E "ANR in|OutOfMemoryError|FATAL|am_kill|lowmemorykiller|lmkd|Choreographer"

# Android 11+: the system's own record of WHY each process died (low memory / crash / ANR)
adb shell dumpsys activity exit-info com.capi.app

adb bugreport ./bugreport.zip                     # includes /data/anr/ traces with the main-thread stack
adb shell run-as com.capi.app du -sh cache files  # debug build: is the video cache growing?
```

### 4. Debug with profilers

- **Android Studio Memory Profiler:** record the 4 videos, force a GC between videos, and take a **heap dump** after each one. With a leak, the Java/native heap climbs in steps (e.g. +80 MB per video) and never drops. The heap dump shows 4 retained `ExoPlayer`/`MediaPlayer` instances, or Activities with their bitmaps.
- **LeakCanary** (debug build): gives the exact **leak trace**, e.g. `VideoActivity` → anonymous `Player.Listener` → static field.
- **Perfetto / System Trace:** for the ANR itself it shows what the **main thread** was doing for more than 5 seconds. Likely culprits are long GC pauses (memory nearly full), decoding or reading video files on the main thread, or slow disk I/O when storage is nearly full.
- **`dumpsys activity exit-info`** is the strongest single proof: it states the exit reason (`LOW_MEMORY`, `ANR`, `CRASH_NATIVE`, ...) for each recent death of the app's process.
- **Device logs** from crash reporting (Firebase Crashlytics or Play Console ANR clusters) confirm that it's the same stack in the field, on the same RAM class of device.

### 5. Prove the root cause to the developer

I'd send one short bug report with:

1. **Exact steps and device** (model, RAM, Android version, free storage), and the reproduction rate (5/5 on a 4 GB device, 0/5 on an 8 GB device).
2. **A graph of memory per video** from `dumpsys meminfo`: 180 → 260 → 340 → 420 MB → killed. On a fixed build it goes back to about 180 MB after each video.
3. **The heap dump or LeakCanary trace** naming the object that isn't released, and the code path holding it.
4. **The ANR trace** showing the main thread stack.
5. **A suggested fix and a check for it:** release the player in `onStop`, cap the video cache size, and stream from a file rather than loading it into memory. My script, re-run on the fix build on a 4 GB device, becomes a regression test, plus a **Macrobenchmark / memory budget** check in CI.

---

## Scenario E: The HFC engine

**Goal:** the engine must catch inconsistent answers without trapping the enumerator on data that is unusual but true (a 14-year-old in college does happen).

**What the specs say.** The Builder spec (§11) defines four actions and four severities, and the engine now implements all four actions (`web/renderer.js`, tested in `tests/web/android-spec-hfc.spec.js`):

| Action | Behaviour (spec) | How it's tested |
|---|---|---|
| `flag_silently` | Record a flag, no prompt | Age 105 submits with no prompt; payload carries `flagged_silently` |
| `reask_once` | Re-ask once, then accept and flag | Hours 20: re-asked; submitting again is accepted with `accepted_after_reask`, severity Soft |
| `reask_and_flag` | Re-ask, always flag | Household schema B4 tests: re-asked until confirmed, then flagged |
| `block` | Block until corrected | Age 3: blocked on every submit, **no** "answers are correct" button; submits once corrected |

Severities are Critical, Hard, Soft and Observation; the Android spec says the app only has to handle **Soft** checks for this exercise. So `block` is legitimate, but only for Hard/Critical rules on truly impossible data. A Soft rule must never use it.

**From the provided schema and the Android spec.** The schema's only HFC rule (`hfc_sleep_plausible`) is a good real example of why the engine needs tests *and* the schema needs a contract. It uses the wrong key (`questioID` instead of `attr`, PS-02), it can never fire because of the question's own visibility logic (PS-03), and it compares numbers as strings (PS-06). The Android spec uses the same rule id for a different check, `q_3 > 16` (PS-21). I automated the spec's version: 16 hours doesn't fire, 16.5 and 24 do, and 25 is rejected by the range validation before the HFC runs. Its action `reask_once` is documented, but the brief asks for "re-ask and flag", which is the stricter `reask_and_flag`; the product owner should confirm which one is wanted (PS-14). The plan below is written against the brief's two example rules.

18 rule cases are read straight from `test-cases/hfc-engine-test-plan.csv` by `tests/unit/hfc-engine.spec.js`, and the re-ask flows are automated in the web form (`tests/web/skip-logic.spec.js`, group B4). The last column shows exactly what is automated and what is a planned manual or device test.

| # | Type | Scenario | Input | Expected | Automated in |
|---|---|---|---|---|---|
| 1 | Positive | Age/education rule fires | Age 12, College | Re-ask both questions with the message; submit held until changed or confirmed | HFC-01 + B4 UI test |
| 2 | Positive | Sleep rule fires | Sleep well = Yes, 4 hours | Re-ask | HFC-02 |
| 3 | Positive | Two rules at once | Age 12 + College, sleeps well 5 h | **One** combined re-ask screen listing both, not two screens one after another | HFC-03 + B4 UI test |
| 4 | Positive | Enumerator corrects the answer | Change College → Primary | Submits with **no** flag | B4 UI test |
| 5 | Positive | Enumerator confirms the answer | Tap "Answers are correct" | Submits **with** flag `HFC_AGE_EDU`, for supervisor review | B4 UI test |
| 6 | Negative | Consistent data | Age 25 + College; sleeps well 8 h; doesn't sleep well, 4 h | No re-ask | HFC-04 to HFC-07 |
| 7 | Boundary | Exactly on the limit | Age **15** (rule is `< 15`); sleep **6** h (rule is `< 6`) | No re-ask | HFC-08, HFC-10 |
| 8 | Boundary | Just past the limit | Age 14; age 0; sleep 5.9 h | Re-ask | HFC-09, HFC-11, HFC-12 |
| 9 | Edge | Partially answered | Age empty + College; sleep well = Yes, hours empty | No re-ask. Rules don't fire on missing data, so there are no false alarms while the user is still filling in | HFC-13 to HFC-15 |
| 10 | Edge | Zero and negative values | Sleep 0 h; sleep -1 h | 0 fires (a real answer). A negative value is caught by range validation first, and the engine doesn't crash | HFC-16, HFC-17 |
| 11 | Edge | Number stored as text | Age "12" (string) | Compared as a number, so it still fires | HFC-18 |
| 12 | **Loop** | Confirm, then submit again | Same answers | **No second re-ask.** The confirmation is remembered for those exact answers | B4 UI test |
| 13 | **Loop** | Confirm, then change to another invalid value | Age 12 → 13, still College | Re-ask again (new data, new check), and the user can still confirm | B4 UI test |
| 14 | **Loop** | Two rules that contradict each other | Rule A requires X, rule B rejects X | Should be caught when the form is **built**; at run time, after N re-asks the app flags and lets the user continue | Planned: not in `validateSchema` yet |
| 15 | Loop | The rule's question gets hidden by skip logic | Answer changed so a referenced question disappears | Hidden answers are cleared, so the rule can't fire on data the user can't see | Partly: the form clears hidden answers (B1 test); HFC-13 covers rules with empty values |
| 16 | Edge | Rule inside a roster | Member 3: age 12 + college | Fires for member 3 only, and highlights member 3's answers | Planned: this sample engine only checks top-level rules |
| 17 | Edge | Offline and interrupted | App killed on the re-ask screen | On reopen, answers are kept and the re-ask shows again; no crash | Manual on device |
| 18 | Edge | Schema update while a survey is in progress | Rule changed in builder v4; device has a v3 survey open | The v3 survey finishes with v3 rules (pinned by `schema_version`) | Manual on device |
| 19 | Performance | 200 rules, 300 questions | Low-end phone | Rule evaluation under 100 ms on submit; no ANR | Manual / benchmark on device |
| 20 | Usability | Message clarity | Hindi message, low-literacy user | Short message with an icon, and the questions involved are highlighted | Manual with users |

**Design points I'd confirm with the team**

- **Hard checks vs. soft checks.** Impossible values (age 250, negative hours) are range validations or `block` rules with severity Hard/Critical: they block until fixed. Unlikely-but-possible combinations are Soft rules: `reask_once` or `reask_and_flag`, then allow with a flag. The contract accepts only the four Builder actions, and I'd add one more rule: **a Soft or Observation rule may not use `block`**, so nobody can configure a rule that traps the user on true data.
- **Ask for a reason.** When the enumerator taps "Answers are correct", the app should ask for a short reason (or a voice note). The supervisor gets context, and a careless "confirm everything" habit becomes visible in the data.

---

# Part 3 – QA process and AI integration

## 1. My first 30 days as the first QA engineer

The principle: **add safety nets that cost developers minutes, not days.** Automate the boring checks, and put human effort where the risk is: offline data and sync.

**Week 1 – Listen and map the risk**
- Talk to developers, product and, if possible, a field supervisor. Read Play Console crash/ANR data and support tickets.
- Map the critical flows: login → download form → collect offline → sync → supervisor sees the data. Rank them by risk: data loss > wrong data > crash > UX.
- Write a **15-minute smoke checklist** for those flows and run it on every build myself, on a real low-end phone.

**Week 2 – Environments and release gates**
- **Staging:** a staging backend with production-like data (anonymised), plus a **debuggable staging app variant** so DB inspection and Charles work.
- **Play Console tracks:** Internal testing (team) → Closed testing (5–10 field supervisors) → **staged rollout** (5% → 20% → 100%) with a crash-rate check before each step. No more pushing straight to production.
- Agree **entry and exit criteria** (below) with the team. Keep them short, or nobody follows them.

**Week 3 – Automation where it pays**
- In CI on every pull request: schema contract tests, logic-engine unit tests, and API contract tests for `/sync-survey` (this repo is the start). Under 10 minutes, so they don't slow anyone down.
- A small **Maestro/Espresso** smoke suite on a low-end device in Firebase Test Lab nightly.
- Crashlytics alerts for new crash clusters.

**Week 4 – Make it a habit**
- A bug template (steps, device, build, logs, severity) and a weekly 30-minute triage.
- A "QA kick-off" for risky features: I join the planning discussion for 15 minutes to agree test ideas *before* coding (shift-left).
- A one-page Definition of Done, plus a metrics baseline: crash-free users %, ANR rate, escaped bugs per release, sync failure rate.

**Entry criteria (a build comes to QA when):** the feature is merged to the release branch, CI is green (unit + contract + API), it's deployed on staging, and release notes say what changed and what is risky.

**Exit criteria (a build can go to the Play Store when):** there are no open P1/P2 bugs, the smoke checklist has passed on a low-end device, the offline → sync regression has passed, a DB migration from the previous version has been tested, and the staged rollout shows crash-free users ≥ 99.5% at 5% before going wider.

**How it stays fast:** checks run automatically in CI, manual testing is risk-based (deep on sync and data, light on static screens), small changes can take a fast lane (smoke test only), and every release still ships the same day if the gates are green.

## 2. How I use AI in QA

- **Test idea generation:** I give the requirement or a bug and ask for edge cases I might have missed. I keep what makes sense and drop the rest.
- **Test data:** realistic Hindi/Marathi names, villages, boundary values, large rosters.
- **Boilerplate:** page objects, Playwright/Postman scaffolding and regex. I always review and run the result.
- **Log analysis:** summarising a long logcat or ANR trace to find where to look first. I then confirm it in the actual trace.
- **Bug reports:** turning rough notes into clear steps, expected and actual results.
- **Rules:** never paste real respondent data or secrets into public AI tools, and never trust generated tests without running them and watching them fail first.

**Specific example for Scenario B (dynamic schemas):**
1. I give the AI the schema and ask: *"List every skip-logic and HFC rule. For each, give the values that make it true, false and on the boundary, and any rules that depend on each other."* This produces a test matrix in minutes for a 200-question form.
2. I ask it to **generate mutated schemas** that a builder bug could produce: a deleted referenced question, a renamed option value, an unknown type, a circular reference. These become contract-test cases, like the 13 mutations in `tests/unit/schema-contract.spec.js`.
3. I ask it to write the **generator** that turns rules into tests (like `tests/web/schema-driven.spec.js`), then review and debug it myself.
4. For a new input type in the builder, I ask what could break on an old app version that doesn't know the type. That becomes a backward-compatibility test.

The AI speeds up the *thinking and typing*, but the tests themselves are deterministic code in the repo. Its output is reviewed, run and kept under version control.

## 3. Deciding what to automate, and why these tools

**Automate when** the check is repeated every release, its result is objective (true/false), the area is high-risk (sync, data integrity, skip logic), it's data-heavy (many combinations), or it's too slow or impossible by hand (150 parallel devices, race conditions).

**Don't automate (yet) when** the feature is still changing every week, the check is a human judgement (readability, sunlight, "does this make sense to a field worker"), it's a one-off, or the setup cost is far higher than running it by hand a few times (a real 2G village network).

**A quick rule I use:** *risk × how often it runs ÷ cost to build and maintain.* With limited time I start at the bottom of the pyramid: contract and logic tests first (cheap, fast, stable), then API, then a thin layer of UI tests.

**Why these tools for Part 1**
- **Playwright for both the API and the web tests:** one language and one test runner. It has a built-in `request` client for APIs, auto-waiting for dynamic UI (ideal for screens that appear and disappear with skip logic), traces and screenshots on failure, parallel runs, free CI, and device emulation for a small-phone viewport.
- **A zero-dependency Node mock server:** the tests run anywhere in seconds, and I can switch on a known bug (`MOCK_BUG=overwrite`) to prove the tests catch it.
- **A Postman collection:** many developers already use Postman, so they can run the duplicate-ID check themselves, and Newman runs it in CI.
- **For the Android app itself** I would add **Maestro** (fast, readable flows for smoke tests) or **Espresso** (in-process, works with the dev team's code), plus **Charles/mitmproxy and ADB** for network and state control. Appium only if one cross-platform suite is a must.

---

# Part 4 – UI/UX and user-centric QA

### Scenario: the new "Training Video Hub" screen

The screen has a standard video player, 3 paragraphs of description, and a standard-sized "Next" button at the very bottom of a scrollable page.

The Android App Specification adds context for this screen: training has 2–3 video modules (thumbnail + "Watch Video"), each followed by a quiz with **visual answers**, **green/red feedback** and **large touch targets**, and the dashboard shows training status (Pending / In Progress / Completed).

### How I'd evaluate it beyond functional testing

I'd test it as the **actual user in the actual conditions**: a budget phone (720p, 5–5.5 inch, 4 GB RAM), outdoors, on 2G or offline, in the local language, by someone who reads slowly or not at all. I'd use field-usability heuristics (my checklist is in `test-cases/part4-field-usability-checklist.csv`), measurable accessibility standards (Material touch targets, WCAG contrast), and at least a few sessions with real or proxy field workers.

### UX/UI issues and rendering risks I'd flag

1. **Too much text for low-literacy users.** Three paragraphs is a wall of text. Most users won't read it, and some can't. Better: 1–2 short lines, icons, and an audio "listen" button in the local language.
2. **"Next" is hidden at the bottom of a scrolling page.** On a small screen the main action is off-screen, and users may think they're stuck. It should be a **sticky bottom button**, always visible.
3. **The "Next" button is standard-sized.** Field users often have rough or gloved hands and hold the phone one-handed while walking. The button should be large and full-width, at least **48×48 dp** (ideally bigger), with a clear icon (→) as well as text.
4. **Low contrast in bright sunlight.** Grey-on-white text and thin player controls disappear outdoors. Text needs a contrast ratio of at least **4.5:1** (aim for 7:1), with bold weights and no meaning carried by light colours alone.
5. **The video player is a risk on budget phones.** Playback can push memory up (see Scenario D's crash), and a high bitrate stutters. The player needs a low-resolution option, must be released when leaving the screen, and should show a clear "downloaded / not downloaded" state when offline.
6. **The standard player controls are small and unfamiliar:** a tiny scrubber and icons without labels. They need big play/pause controls and a clear completion indicator ("✔ watched").
7. **Text expansion and font scaling.** Hindi/Marathi text and the user's large-font setting can push the button further down or clip text. The screen must be tested at the largest font scale.
8. **Data and network:** streaming on 2G without a warning burns the user's data pack. The screen needs a download-first approach with a size warning, and resume support.
9. **No progress or orientation cues:** which video is this (2 of 5), and what happens after Next? A progress bar or steps help users who don't read.
10. **Interruptions:** a call, a low-battery dialog or a screen rotation shouldn't restart the video from zero.
11. **Quiz feedback relies on green/red.** The spec's quiz shows right/wrong as green/red. About 1 in 12 men has red-green colour blindness, and colours wash out in sunlight. Feedback needs an icon (✔ / ✖), a short word and ideally a sound or vibration as well.
12. **"Watch Video" marks completion without real watching.** In the mock the button fakes completion. In the real app, completion should need most of the video watched (or the quiz passed), and the dashboard status (Pending → In Progress → Completed) must survive going offline and restarting the app.

### How I'd test for these systematically

- **A low-end device lab:** at least one real 4 GB, 720p phone running the most common Android version in the field, plus emulators at **360×640 dp**, **font scale 1.3–2.0** and **Display size: Largest**.
- **Automated accessibility checks:** Google **Accessibility Scanner**, Espresso `AccessibilityChecks.enable()` in UI tests (flags touch targets under 48 dp, low contrast and missing labels), and Layout Inspector for sizes.
- **A sunlight test:** check the screen outdoors at noon at 50% brightness, and take photos as evidence.
- **Screenshot tests** at different font scales and languages (Paparazzi or Roborazzi), to catch clipped text and a hidden button in CI.
- **Performance:** play the videos back to back while watching memory (Scenario D), and play on a throttled 2G network.
- **Real-user sessions:** 5 field workers or proxies, given simple tasks ("watch the video and go to the next one"), observed without help. Time on task, and where they hesitate, tells more than any checklist.

### How I'd communicate "non-functional" bugs constructively

- **Show it, don't argue it.** A photo of the screen in sunlight, a 10-second video of a user scrolling and failing to find Next, the Accessibility Scanner result. Evidence turns "my opinion" into a shared fact.
- **Tie it to the user and the business.** "Users can't find Next, so they leave training incomplete, so data quality drops," not "the button looks small".
- **Use objective standards:** Material Design touch targets, WCAG contrast ratios, our own field persona. These end debates about taste.
- **Propose a fix,** with a mock-up or reference ("sticky full-width button like the survey screens"), and give it a severity using the same scale as functional bugs. Label it `UX` so it's tracked, not forgotten.
- **Shift left:** ask to review designs and Figma files **before** development with a short field-usability checklist, so most of these issues never reach code. And credit the team when it's fixed.

---

## Assumptions

- **Reference documents:** all four provided files were reviewed and are kept in `docs/reference/` (the schema itself is in `schema/provided/`). Where the documents disagree with each other or with the schema (PS-14, PS-20 to PS-23), I followed the **Builder spec** for the data model and HFC semantics and the **Android spec** for parsing and display, and logged the conflict as a question for the team instead of guessing silently.
- **Format the web form reads:** it reads the format of the provided schema (`questions`, `validationRules`, string `hintText`), because that is what the app is asked to parse. It also accepts `items` and list-valued hints and checklists, so it keeps working if the builder switches to its documented model. Input types that need device hardware (Image, Audio, GPS, Matrix) are outside this web demo.
- **Extra sample schema:** the schema in `schema/household-survey.schema.json` is my own sample, covering text, number, decimal, single and multi-select, a roster, chained skip logic and HFC rules. The form renders whatever schema it is given, and the generated tests (`schema-driven.spec.js`) and the schema contract run on any schema in `schema/` (`SCHEMA=<file>`). The hand-written tests (`skip-logic.spec.js`) and the HFC plan use questions from this sample. If the real builder format differs, `web/renderer.js` and `web/logic.js` need adapting, and the hand-written tests need their question names updated.
- **Web form vs. app:** the web form stands in for the app's dynamic renderer so the skip-logic approach can be automated and shown here. On Android, the same test cases would run as Espresso or Maestro flows.
- **Package name:** `com.capi.app` is a placeholder in the ADB commands.
- **The mock server stands in for the real backend.** The same tests can point at staging by changing `baseURL`. Behaviours that need the real system, such as authentication per user and server-side photo storage, are listed as manual or future tests in the CSV plans.
