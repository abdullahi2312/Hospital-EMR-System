# Phase 12 — Full Live System Testing Report

Date: 2026-11-08

## Safety and test environment

- No `.env` or `.env.local` contents were inspected, printed, or changed during Phase 12.
- The existing MongoDB service was left running and unmodified. The test suites used a separate MongoDB 8.3 process on `127.0.0.1:27018`, with replica set `rs0` and a fresh temporary data directory. `hello` confirmed `setName: rs0` and an elected primary.
- The HTTP E2E suite created a uniquely suffixed test database and synthetic users/records. It did not use application credentials or the configured application database.
- The temporary `mongod` was shut down after testing. Its data directory is gone; its log remains under the temporary Phase 12 run directory. The other MongoDB process was not stopped or reconfigured.
- Docker and Docker Compose were unavailable. The installed local `mongod.exe` was sufficient for an isolated replica set.

## Browser testing

Browser automation was attempted through the available computer-use tool. The helper timed out while listing apps, and its browser host reported unavailable. No browser login, UI workflow, language switch, or viewport test was performed. No browser result is claimed.

## Workflows verified through HTTP and MongoDB

The real Express application and MongoDB models were exercised by `server/tests/http-mongodb.e2e.test.js` against the isolated replica set. Result: **10 passed, 0 failed, 0 skipped**.

- All six role accounts authenticated through the login endpoint.
- Reception registered a synthetic patient; the test simulated a lost save acknowledgement and retried with the same key. It verified the original MRN/result was recovered, the payload-mismatch retry conflicted, and one patient, operation, audit record, and MRN sequence allocation remained.
- Admin created an active department through the new authenticated endpoint; the receptionist could list it, a doctor was denied the list, and department creation was audited. Reception used its code to create an encounter; admin assignment and assigned-doctor clinical documentation persisted.
- Allergy restrictions and authorized override were checked, including the persisted prescription and Medication reference.
- Laboratory staff completed an ordered component result through HTTP and MongoDB.
- Pharmacy dispensing committed inventory, prescription, dispense, and audit updates together in a transaction.
- Patient portal ownership/privacy, consent grant and revocation, payment simulation/audit, and private PDF access were checked.
- BreakGlass activation/audit/expiration and referral notification persistence were checked; inactive users were denied access.

The MongoDB reliability integration suite finished **8 passed, 0 failed, 0 skipped**. It covered indexes, concurrent retry behavior for patient registration, stock and payment idempotency, notifications, consent/BreakGlass expiry, and dispensing transaction behavior.

There was one transient failure on the first full integration run: a concurrent same-key patient registration received the expected retryable “still processing” conflict before its peer completed. The focused concurrent registration test then passed, and the subsequent full integration rerun passed 8/8. This first-run flake is recorded rather than hidden.

## Other verification

- Complete backend suite: **209 tests; 205 passed, 0 failed, 4 skipped**. The replica-set suites are skipped by the default command when no integration URI is provided; they were run separately as noted above.
- Frontend ESLint: passed.
- Frontend production build: passed.

Commands used for the isolated database suites:

```powershell
$env:MONGO_INTEGRATION_URI = 'mongodb://127.0.0.1:27018/phase12_e2e_test?replicaSet=rs0'
npm.cmd run test:integration
node --test --test-reporter=spec server/tests/http-mongodb.e2e.test.js
```

The complete suite and frontend checks were run with `npm.cmd test`, `npm.cmd --prefix client run lint`, and `npm.cmd --prefix client run build`.

## Verified defect and fix

Encounter creation required a department name/code that resolves to an active `Department`, but the admin Department page and backend had no management or lookup endpoint; reception accepted unverified free text. The backend and frontend department management/lookup workflow was added immediately before this audit. Phase 12 extended the HTTP E2E flow to create the department as admin, verify receptionist lookup and doctor denial, confirm its audit event, and use the selected code for encounter creation. No authorization or encounter validation was relaxed.

Files added/changed for the department workflow: `server/app.js`, `server/services/department.service.js`, `server/controllers/department.controller.js`, `server/routes/department.routes.js`, `server/tests/department.routes.test.js`, `client/src/api/adminApi.js`, `client/src/api/receptionApi.js`, `client/src/pages/admin/DepartmentsPage.jsx`, `client/src/pages/receptionist/EncounterCreationPage.jsx`, and `docs/API.md`.

Phase 12 also updated `server/tests/http-mongodb.e2e.test.js` to exercise department creation and lookup through HTTP rather than seeding that department directly in the test.

## Remaining limitations

- Authenticated workflows were verified using the HTTP E2E suite, not through a browser UI.
- The existing application database and its current department records were not inspected. The tested department was synthetic and isolated.
- Four replica-set-dependent suites are skipped in a plain `npm test` invocation; run the documented integration and E2E commands with an isolated replica-set URI for database-backed verification.
- The first-run concurrent patient-registration timing failure is a known test flake to monitor; the focused rerun and full rerun passed without code changes.

No production system, existing application database, or real patient record was used or modified.
