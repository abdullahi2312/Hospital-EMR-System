# Hospital EMR System

Role-based electronic medical record demonstration application with a Node.js/Express/MongoDB API and a React/Vite/Tailwind frontend. It is an educational project, not a certified medical device or production-ready deployment.

## Main features and architecture

- JWT authentication with server-side active-user and role checks.
- Patient registration with server-assigned MRNs, duplicate checks, idempotent retry recovery, and audit records.
- Reception identity directory, department selection, and encounter check-in.
- Doctor encounter notes, vitals, diagnoses, prescriptions, lab orders, referrals, and audited BreakGlass access.
- Laboratory queue, result entry, and supported sample rejection.
- Pharmacist prescription queue, inventory batches, and transaction-protected dispensing.
- Patient-owned portal, consent, permitted visit/results/prescription views, private PDF summary, and simulated payments.
- Admin account and department management, doctor assignment, analytics, and audit/access-log review.
- Somali and English UI text.

The React client calls Express through the development proxy. Express validates JWTs against the current active MongoDB user and enforces role and patient-access rules; frontend guards do not grant access. See [architecture](docs/ARCHITECTURE.md), [API documentation](docs/API.md), and [requirements traceability](docs/REQUIREMENTS_TRACEABILITY.md).

## Requirements and setup

- Node.js 22 LTS or newer.
- MongoDB 7 or newer. A replica set or sharded cluster is required for transactional prescription dispensing; standalone MongoDB starts the API but dispensing fails closed.
- Copy `.env.example` to `.env`, replace every placeholder with distinct random secrets, and configure a development-only MongoDB URI. Never commit `.env` or reuse development secrets in production.
- If `PATIENT_IDENTITY_HMAC_SECRET` is not configured, `npm run config:patient-secret` creates only the missing key in the Git-ignored `.env.local`; it preserves a key already present in `.env`. Keep the value stable because it is used for existing patient duplicate-detection fingerprints.
- Install and start:

```powershell
npm ci
npm run dev
```

The server connects to MongoDB, creates/verifies declared indexes without dropping existing indexes, runs the initial BreakGlass expiration pass, and only then listens on `PORT` (default `5000`). Startup fails closed if database/index initialization or the expiration pass fails. Use Ctrl+C for graceful shutdown.

### Local MongoDB

Use a local development database and keep it separate from production. The application does not create the MongoDB server for you. Standalone MongoDB is suitable for ordinary development and the patient portal, but pharmacy dispensing uses a transaction and fails closed on standalone MongoDB. Transaction E2E tests require a disposable replica set and test database; see [MongoDB reliability and integration tests](docs/MONGODB_RELIABILITY.md). Do not convert or reconfigure a shared MongoDB server to run those tests.

### Frontend

In a separate terminal from the repository root:

```powershell
Set-Location client
npm ci
npm run dev
```

Open `http://127.0.0.1:5173`. Vite proxies `/api` to `http://127.0.0.1:5000`. For another same-origin deployment, set the public `VITE_API_BASE_URL`; never put secrets in a `VITE_*` variable. Run `npm run lint` and `npm run build` from `client/`. No frontend test framework or frontend test files are currently configured.

### Six application roles

- **Receptionist:** registers patients and handles identity lookup/check-in; cannot assign doctors or view clinical notes.
- **Doctor:** works assigned encounters and performs authorized documentation, diagnoses, prescribing, lab ordering, referrals, and emergency access.
- **Lab Technician:** handles the authorized laboratory queue, results, and sample rejection.
- **Pharmacist:** reviews eligible prescriptions, inventory, and transactional dispensing.
- **Patient:** views own identity, visits, completed lab results, prescription history, and consent; downloads a private summary.
- **Admin:** manages accounts, analytics, audit/access-log review, patient identity, and doctor assignment; admin role does not grant general clinical access.

Backend authorization remains authoritative. Frontend navigation and route guards do not grant permissions.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `PORT` | No | HTTP port; defaults to 5000. |
| `NODE_ENV` | No | Runtime mode. |
| `MONGO_URI` | Yes | Application MongoDB connection. Never point production code at a test/demo database. |
| `JWT_SECRET` | Yes | Random secret used to sign and verify access tokens. |
| `JWT_EXPIRES_IN` | Yes | JWT lifetime, for example `1d`. |
| `PATIENT_IDENTITY_HMAC_SECRET` | Yes | Dedicated random secret (at least 32 bytes) for private patient duplicate-detection keys. |
| `PAYMENT_FINGERPRINT_SECRET` | Yes for payment initiation | Dedicated random secret (at least 32 bytes) for normalized payment-input HMAC fingerprints. |
| `VITAL_*` | No | Configurable input plausibility bounds and reference thresholds. See `.env.example`; thresholds flag values and are not diagnoses. |
| `HOSPITAL_EMR_BOOTSTRAP_*` | Bootstrap only | Runtime-only local admin bootstrap settings; see `docs/ADMIN_BOOTSTRAP.md`. |
| `MONGO_INTEGRATION_URI` | No | Explicit isolated integration-test connection; never read by the application startup. |
| `MONGO_DEMO_URI` | No | Explicit local demo database connection; only used by the guarded demo seed script. |
| `DEMO_SEED_PASSWORD` | No | Local-only password used to provision demo accounts; never log or commit it. |
| `VITE_API_BASE_URL` | No | Public frontend API base URL; defaults to `/api`. Never store credentials or secrets in this Vite variable. |

The `.env.example` values are placeholders, not deployable secrets. Generate independent secrets with a trusted local secret generator. Do not paste production secrets into issue reports, shell transcripts, or source control.

## Available commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start with nodemon. |
| `npm start` | Start production entry point. |
| `npm test` | Run backend unit/HTTP tests and report the opt-in Mongo integration suite as skipped when not configured. |
| `npm run test:integration` | Run integration tests against a unique, generated database derived from `MONGO_INTEGRATION_URI`; see [Mongo reliability and index deployment](docs/MONGODB_RELIABILITY.md). |
| `npm run db:indexes` | Explicitly create/verify model indexes for `MONGO_URI`; review the target environment before running. |
| `node server/scripts/seed-demo.js` | Seed the guarded fictional demo dataset; see [Demo workflow](docs/DEMO_WORKFLOW.md). |
| `npm run config:patient-secret` | Create the missing local patient identity key without changing an existing key. |
| `npm run admin:bootstrap` | Guarded one-time local admin bootstrap with a hidden password prompt; see [Admin bootstrap](docs/ADMIN_BOOTSTRAP.md). |
| `npm run lint` from `client/` | Run frontend ESLint. |
| `npm run build` from `client/` | Create the frontend production build. |
| `node --test server/tests/patient-portal.mongo.test.js` | Run patient portal HTTP/MongoDB verification with an explicit local test URI. |

## API and demo documentation

- [API routes, authentication, request examples, and response envelopes](docs/API.md)
- [Local demo setup and walkthrough](docs/DEMO_WORKFLOW.md)
- [Six-role demonstration guide](docs/DEMO_GUIDE.md)
- [System architecture](docs/ARCHITECTURE.md)
- [MongoDB index deployment and isolated integration tests](docs/MONGODB_RELIABILITY.md)
- [First Admin account bootstrap](docs/ADMIN_BOOTSTRAP.md)
- [Requirements traceability](docs/REQUIREMENTS_TRACEABILITY.md)
- [Phase 12 test report](docs/PHASE12_TEST_REPORT.md)
- [Phase 13 final submission report](docs/PHASE13_FINAL_SUBMISSION_REPORT.md)

## Important scope and compliance notes

- Payment and SMS integrations are explicitly simulated. The backend does not transfer real money or send real SMS messages.
- SMS notices are simulated; they are not real delivery or a general-purpose notification guarantee.
- FHIR endpoints provide limited read-only FHIR-style JSON mappings; they do not claim full FHIR conformance or certification.
- Current persistence is MongoDB/Mongoose. The authoritative organizer brief was not found in the repository or available attachments, so exact rubric compliance remains unverified. MongoDB references are not relational foreign keys. See [requirements traceability](docs/REQUIREMENTS_TRACEABILITY.md) and compare with the organizer's brief when available.
- The patient summary embeds Noto Sans Latin and Latin Extended subsets for Somali and supported extended-Latin text. Glyphs outside these bundled subsets fall back to `?`.
- Patient portal HTTP/MongoDB tests use an isolated local database. The transaction commit path requires a replica set; a standalone MongoDB run does not verify transactional dispensing.
- Mongoose is pinned to the patched 8.24.8 release in this workspace. Run the current dependency audit before submission/deployment; no claim is made here about advisories added after the recorded upgrade.
- The project is not represented as production-ready. Deployment hardening and compliance review remain necessary.
- MongoDB does not enforce Mongoose `ref` existence automatically. Services validate references in workflows, but direct database writes and administrative modification remain outside application-level guarantees.

## Security and operations

All production deployments need TLS at the ingress, an explicit CORS allowlist if cross-origin access is required, request-size limits, rate limiting appropriate to the deployment, secret rotation procedures, backups, and monitoring. Login has application rate limiting; confirm the proxy/network boundary and deployment-specific controls before exposing the service publicly. Index initialization does not remove indexes and may fail if historical duplicates conflict with a new unique index; resolve such cases using a reviewed migration, never an automatic destructive sync.
