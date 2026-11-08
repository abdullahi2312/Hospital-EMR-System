# System Architecture

## Components and trust boundaries

- **React client (`client/`)**: Vite, React Router, Axios, Context API, and Tailwind. It stores the local authentication session, sends the bearer token to the API, and limits navigation by role. Client checks are usability controls, not authorization.
- **Express API (`server/`)**: validates inputs, JWTs, current active-user state, role permissions, patient ownership/access policy, and workflow-specific state transitions. Sensitive work is enforced in middleware and services.
- **MongoDB/Mongoose**: stores users, patients, encounters, clinical records, medications, inventory, audit/access records, consent, notifications, and workflow idempotency operations. Schema references are application-level references, not relational foreign keys.

The API is mounted under `/api`. Development Vite proxies `/api` to the backend. Startup connects to MongoDB, creates/verifies declared indexes without dropping existing ones, performs BreakGlass expiration cleanup, then listens. Configuration is loaded from project-root environment files; secrets must remain local.

## Authentication and roles

Staff sign in through `POST /api/auth/login`; patients use `POST /api/auth/patient-login` with linked MRN, phone, and password. The API issues a JWT. On each protected request, the server resolves the active user and current role from MongoDB. The official application roles are Admin, Receptionist, Doctor, Lab Technician, Pharmacist, and Patient. No Nurse role is defined.

Roles limit operations, but record access may be narrower. Admin privileges do not automatically grant clinical access. Doctors access assigned encounters and can use patient consent or a currently valid BreakGlass authorization under the shared access policy. Patient portal identity is derived from the authenticated account link, not from a caller-supplied patient ID.

## Patient registration and encounter lifecycle

Reception (or Admin) submits identity and registration fields to `POST /api/patients`. The server validates data, checks private identity fingerprints, allocates the MRN, persists an operation keyed for replay, and writes an audit event. A same-key retry can recover the original result after an uncertain response; reusing the key with different input conflicts.

Encounter creation is available to Reception (and Admin) through `POST /api/encounters`, using an active department selected from `GET /api/departments`. Department creation is Admin-only and audited. Doctor assignment is Admin-only. The assigned doctor performs authorized notes, vitals, diagnoses, prescriptions, lab orders, and referrals; closing is subject to encounter status and authorization rules.

## Doctor, laboratory, and pharmacy workflows

- **Doctor:** encounter APIs enforce assignment or valid patient-access policy. Prescription validation checks medication references and allergy rules; override requires the supported authorization and an audit record. Lab orders and referrals use server validation and stateful operations.
- **Lab Technician:** reads the authorized pending queue, opens permitted order detail, enters validated results, and can reject a sample where supported. Server responses determine status and abnormal flags.
- **Pharmacist:** views eligible prescription queue and details, selects inventory batches, and dispenses only within remaining prescribed quantity and stock. Inventory deduction, dispense record, prescription update, and audit persistence are handled within the server transaction. A MongoDB replica set or sharded cluster is required; standalone deployments fail closed.

## Patient portal, consent, and BreakGlass

The portal limits views to the patient linked to the current account and returns only permitted visits, completed lab results, prescription history, consent, and a private PDF summary. Consent is patient-owned and controls doctor access to clinical records. BreakGlass is a doctor workflow with reason, expiry, access logging, and admin review; expired or invalid authorization does not grant access. Access checks fail closed when required logging cannot be written.

## Audit and reliability

AuditLog stores workflow events and is append-only at the model boundary. AccessLog records patient-access decisions. Sensitive details are filtered by schemas/services; audit logs are not a cryptographic tamper-evident archive. Durable idempotency records and unique indexes protect patient registration and other supported retryable workflows. Payment and SMS adapters are simulated, not external integrations. FHIR-style routes are read-only mappings only, not certified interoperability.

## Verification limits

HTTP-to-MongoDB workflows and MongoDB integration checks were run against an isolated local replica set (see `PHASE12_TEST_REPORT.md`). Browser workflows were not verified because browser automation was unavailable. Production deployment, medical safety, privacy/legal compliance, and the official challenge rubric remain unverified.
