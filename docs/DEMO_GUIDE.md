# Six-Role Demonstration Guide

This guide is for a fictional, isolated local demo only. Use a dedicated database named `hospital_emr_demo_*` on a local MongoDB host. Never use production or real patient data. For transaction-based dispensing, use a disposable replica set. The seed script is guarded, requires an explicit `MONGO_DEMO_URI` and local-only `DEMO_SEED_PASSWORD`, and refuses remote hosts or other database names. See `docs/MONGODB_RELIABILITY.md` for temporary replica-set setup.

## Prepare the demo

1. Start an isolated local MongoDB instance and select a fresh demo database (for example, `hospital_emr_demo_local`). Do not reuse an application or production database.
2. Configure a local-only patient identity secret and payment fingerprint secret. Use distinct random values and keep them private; do not place them in source control or `VITE_*` variables.
3. In PowerShell, set `MONGO_DEMO_URI` to the local demo database and enter a demo-only password through your secret manager or a hidden prompt into `DEMO_SEED_PASSWORD`. Do not print or commit either value.
4. Run `node server/scripts/seed-demo.js`. It creates synthetic users and catalog fixtures only in the explicit demo database. Usernames are `demo_admin`, `demo_receptionist`, `demo_doctor`, `demo_lab`, `demo_pharmacist`, and `demo_patient`; use only the password you supplied at runtime. The seed data includes a synthetic patient, active `DEMO` department, medication, and inventory batch.
5. Configure the application backend to use that same local demo database, start it with `npm run dev`, then start the client with `npm run dev` from `client/`. Never point the demo frontend/backend at a production service.

The demo seed does not print the password. It may be rerun only against the same dedicated demo database; it does not overwrite conflicting demo identities. Its fixed synthetic patient has no phone number, so it cannot sign in through the MRN/phone patient-login flow. For a portal login demonstration, first register a new fictional patient with a phone number as Receptionist, then link a new patient-role account to that patient's ID using Admin account management. Use the local demo password for the linked account. For a separate local Admin account bootstrap, follow `docs/ADMIN_BOOTSTRAP.md` and confirm the exact existing development database before running the script.

## Demonstration sequence

For each role, sign in through the application login page using the matching demo username and the runtime-supplied demo password. Expected access restrictions are part of the demonstration.

### 1. Admin

- Open Department Management and confirm the active `DEMO` department. Optionally create a clearly synthetic department with a unique code; the operation is audited.
- Review the synthetic staff accounts and account status. Create only demo accounts needed for the walkthrough; admin cannot provision another Admin through ordinary user management.
- Review analytics, audit logs, and access logs. Admin assignment of an encounter is permitted, but Admin role does not grant general clinical-record access.

### 2. Receptionist

- Register a clearly fictional patient with synthetic identity values and record the server-returned MRN. Do not invent an MRN or use real personal information.
- Search the identity directory and create an encounter by selecting an active department. The server returns the visit number.
- Retry a deliberately uncertain registration only with the original unchanged payload and submission key. A different payload with that key must conflict. Reception cannot assign a doctor or view clinical notes, diagnoses, vitals, or other restricted records.

### 3. Doctor

- As Admin, assign the newly created encounter to `demo_doctor` through the supported assignment operation. Then sign in as `demo_doctor`.
- Open the assigned visit; add synthetic notes, permitted vitals, diagnosis, prescription, and lab order. Use only supported medication references and valid allergy behavior. Confirm prescription allergy warnings and audited override restrictions as applicable.
- Create a referral or use BreakGlass only for a synthetic test scenario. BreakGlass requires a meaningful reason, is audited, expires, and remains subject to review. Attempting an unassigned encounter without consent/BreakGlass must be denied.
- Close the encounter only after the workflow permits it; server authorization and lifecycle rules remain authoritative.

### 4. Lab Technician

- Sign in as `demo_lab`, open the pending test ordered for the synthetic encounter, and enter a valid result or reject the sample with a supported reason.
- Confirm the server-returned order status and result. The lab role cannot order tests, edit doctor notes, or close encounters.

### 5. Pharmacist

- Sign in as `demo_pharmacist`, locate the eligible prescription, inspect its details and available inventory batches, and dispense a partial amount followed by the remaining amount where stock permits.
- Confirm the server response, queue status, remaining amount, inventory, dispense history, and audit event. Repeated requests must use the same idempotency key. Never bypass insufficient-stock or quantity checks.
- Successful dispensing requires a transaction-capable replica set. A standalone MongoDB server must fail closed without changing stock.

### 6. Patient

- Sign in using the newly linked patient account's MRN, fictional phone number, and local demo password. View only the account owner's permitted visits, completed lab results, and prescription history; download the private summary PDF.
- Grant and revoke consent for a listed doctor and confirm the server status. Verify internal doctor notes and another patient's record are not shown or accessible.
- Payment UI is not implemented; if demonstrating the payment API, use only the simulator and explain that no funds move. SMS results are simulated and no external provider is contacted.

## Reset and evidence

Do not reset or drop an existing database. To start over, provision a new uniquely named local demo database and use it explicitly. When collecting screenshots, exclude passwords, tokens, real personal information, and connection strings. Browser role workflows were not verified in the recorded Phase 12 run; a demo presentation should be manually rehearsed against the disposable demo environment.
