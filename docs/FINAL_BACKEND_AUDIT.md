# Backend implementation and reliability audit

Audit date: 2026-11-06. This is a source/test review of the checked-out backend, not a clinical validation, penetration test, or production database inspection. The organizer's authoritative challenge brief was not found in the repository; requirements that depend on its exact wording must be confirmed against the organizer's copy.

## Model-by-model review

| Model | Assessment | Relationships, constraints, and material limitation |
| --- | --- | --- |
| AccessLog | PARTIAL | Immutable, server-timestamped patient/user/encounter/consent/BreakGlass references, access-method enums, purpose allowlist, append-only middleware and indexes. MongoDB/Mongoose middleware cannot prevent direct database-administrator edits; referenced-record existence is not a database foreign key. |
| Allergy | PARTIAL | Patient and recorder refs, required allergen/reaction/severity and status indexes. Allergy history and patient embedded allergy strings may differ; service matching is conservative token matching, not a medication-allergy clinical decision system. |
| AuditLog | PARTIAL | Immutable append-only schema, actor/entity/action/date indexes, constrained metadata and partial unique event keys including payment, registration, stock, consent, BreakGlass, and override events. No cryptographic tamper-evidence or external immutable archive. |
| BreakGlass | PARTIAL | Patient/doctor refs, reason validation, exact 24-hour new-document validation, review fields and expiry indexes. Service rechecks active status, review metadata, reason, and expiry per request; startup expiration is cleanup, not authorization. Activation does not have a durable caller idempotency key. |
| Consent | PARTIAL | Patient/doctor/grantor refs, sole clinical-record scope, grant/revoke lifecycle, one-active-consent partial unique index. No expiry field exists, so consent does not expire automatically. |
| Department | PARTIAL | Unique name/code and active flag. Encounter stores department as trimmed text rather than a Department ref, so historical naming changes are not relationally linked. |
| Diagnosis | PARTIAL | Patient/encounter/doctor refs, optional code, free-text description, unique primary diagnosis per encounter. ICD catalog exists locally (FY2027, 74,879 reportable records, `validityFlag: 1`); catalog version updates remain a data maintenance responsibility. |
| Dispense | PARTIAL | Prescription/patient/medication/inventory/pharmacist refs and transaction-date indexes. Atomic stock deduction and status update require replica set/sharded transactions; standalone topology fails closed. |
| Encounter | PARTIAL | Patient/assigned-doctor refs, unique visit number, lifecycle and clinical note fields, patient/doctor timeline compound indexes. Department remains text. MongoDB cannot enforce reference existence. |
| Inventory | PARTIAL | Medication/updater refs, nonnegative quantity, batch uniqueness per medication, expiry/quantity indexes, per-batch replay markers. Replay markers accumulate on the inventory document; monitor document growth. |
| InventoryStockAddition | PARTIAL | Durable actor/key uniqueness and hidden HMAC input/idempotency fields, operation lifecycle and immutable identity. Historical operation/index duplicates must be checked before deployment. |
| LabOrder | PARTIAL | Patient/encounter/doctor/technician refs, single-test legacy support, component schema, status lifecycle and work-queue index. No schema-level FK enforcement. |
| LabResult | PARTIAL | LabOrder/patient/technician refs, type-dependent value validation, reference-range check, abnormal flags and per-component unique partial index. Flag decisions are service-calculated only when sufficient ranges exist; reference ranges are not supplied by a universal catalog. |
| Medication | PARTIAL | Catalog fields, route/form enums and category/activity indexes. Medication name is indexed but not unique; services reject ambiguity where name fallback is needed. |
| Notification | PARTIAL | Recipient/patient refs, type/read lifecycle and recipient inbox index. Simulated SMS is separate; delivery history/idempotency is not represented as a durable provider delivery record. |
| Patient | PARTIAL | MRN unique; private HMAC keys and partial unique indexes for normalized name+DOB, name+estimated-age, and phone; registration actor and timestamp. Duplicate index creation can fail on preexisting duplicates and requires reviewed remediation. |
| PatientRegistrationOperation | PARTIAL | Durable actor/key uniqueness, hidden HMAC fields, one operation per patient, lease/audit-recovery state. Expired operation recovery and production historical consistency should be monitored. |
| Payment | PARTIAL | Unique server reference, per-user idempotency, hidden HMAC fingerprint, USD/SOS enum and simulated terminal states. Payment is simulated only; the adapter's volatile state is not a real provider ledger. |
| Prescription | PARTIAL | Patient/encounter/doctor refs, status, hidden allergy override reason, and new optional Medication ref/index for new records. Medication ref is optional solely for legacy compatibility; legacy pharmacy resolution uses an ambiguity-checked name fallback. |
| Referral | PARTIAL | Patient/encounter/referring-doctor and supported destination refs, constrained status history and date/status indexes. External receiving-hospital identity remains text because no external-hospital directory model exists. |
| User | PARTIAL | Unique normalized username, password excluded by default, six-role enum, active flag and one-patient-account partial unique index. Password hashing is service-layer behavior; no email identity exists in schema. |
| Vital | PARTIAL | Patient/encounter/recorder refs, bounds and per-reading timestamps, required core measurements and indexes. Service returns calculated abnormal flags; Vital schema does not persist them. Configure thresholds for local policy and validate clinically before care use. |

Schema indexes above are declared in model code. They were created and checked in an isolated local MongoDB integration database during this completion pass; this does not verify indexes or data cleanliness in another deployment. Index readiness calls `createIndexes()` at startup, fails closed, and does not drop/synchronize existing indexes.

## Workflows and implementation findings

- Authentication loads current user role and requires `isActive === true`; `authorize` checks only the DB-backed `req.user`. Six roles are present in `User.js` and route policies are explicit, with service checks retained for sensitive operations.
- Patient registration uses a server counter, private HMAC duplicate keys, durable actor/idempotency operations, and deduplicated audit recovery. Actual concurrency was exercised in isolated MongoDB integration tests.
- Encounter create/assignment/list/detail/close APIs and authorization services exist; encounter department is still a string, not a ref.
- Patient-access policy supports self-portal, assigned encounter, valid consent, and unexpired unreviewed BreakGlass, audits allow/deny, and fails closed on audit failure. Receptionists do not have clinical timeline access.
- Vitals, diagnoses, notes, prescriptions, labs, pharmacy, consent, referrals, payments, notifications, analytics, FHIR-style reads, and admin audit review have mounted routes and tests. FHIR is partial and read-only, not certification.
- Allergy override is doctor-only, reasoned, persisted privately, and deduplicated in AuditLog. It does not eliminate clinical decision risk from incomplete allergy data.
- Payment and SMS behavior is simulation-only. No genuine payment or SMS provider test was run.
- General MongoDB `ref` values are application-level pointers; existence is checked by relevant workflows, not enforced as foreign keys globally.

## Integration and concurrency limits

The opt-in integration suite uses only `MONGO_INTEGRATION_URI`, requires a database name identifying test/integration, derives a fresh run-specific database, and drops only that generated database. It verified actual unique indexes, duplicate-key behavior, concurrent patient registration replay, stock-add replay, payment/audit deduplication, notification retries, consent revocation, BreakGlass expiry, and dispensing behavior. The available MongoDB is standalone, so successful transactional dispensing was not verified; the tested behavior is fail-closed with no stock/dispense mutation. Production data, production indexes, replica-set transactions, and multi-process deployment were not inspected.

## Prioritized outstanding risks

1. **Architecture compliance:** If the official rubric mandates relational SQL tables, foreign keys, and migrations, MongoDB/Mongoose does not meet it. No SQL migration is attempted here by explicit project direction.
2. **Production index rollout:** Scan existing production-like data for duplicate values before enabling unique indexes; use reviewed migrations and backups. Do not auto-delete duplicates or drop indexes.
3. **Transaction topology:** Deploy replica set/sharded MongoDB before enabling dispensing. Standalone MongoDB correctly refuses dispensing.
4. **Durable emergency activation retry:** BreakGlass activation lacks a durable caller idempotency contract; repeated activation can create multiple authorizations/notifications. This task did not alter that clinical workflow.
5. **Deployment controls:** Login rate limiting is process-local; shared limits across instances need a trusted gateway or shared store. Configure TLS, ingress rate limits, trusted proxy handling, backups, monitoring, and deployment-specific CORS policy before public exposure.
6. **Data semantics:** Encounter department text and unpersisted Vital abnormal flags limit future reporting/longitudinal consistency. Legacy prescriptions may lack Medication refs and continue through a checked name fallback.
7. **Challenge evidence:** README/API/demo/CI now exist, but the repository has no frontend and the official organizer brief is not included; end-to-end acceptance and the exact rubric remain unverified.
