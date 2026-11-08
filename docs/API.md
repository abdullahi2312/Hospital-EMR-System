# Backend API reference

Base URL for local development: `http://localhost:5000`. Unless listed as public, send `Authorization: Bearer <JWT>`. Login and protected routes resolve current account role/active status from MongoDB. The default JSON envelope is `{ "success": boolean, "message": string, "data": object|null }`; FHIR reads use `application/fhir+json` resources/`OperationOutcome` instead. `Accept-Language: en` or `so` selects English or Somali response messages; English is the fallback. Field names, enum values, and codes remain stable and untranslated.

## Routes

| Method and path | Access | Input / purpose |
| --- | --- | --- |
| `GET /api/health` | Public | Liveness response. |
| `POST /api/auth/login` | Public, login rate limited | `{ username, password }`; returns access token and safe user profile. |
| `POST /api/auth/patient-login` | Public, login rate limited | `{ mrn, phone, password }`; matches the normalized phone to the MRN and returns a token only for the active user linked to that patient. |
| `GET /api/protected/profile` | Any authenticated supported role | Safe current profile. |
| `POST /api/patients` | Receptionist, admin | Patient identity/registration fields plus required `idempotencyKey`; actor and MRN come from the server. |
| `GET /api/patients?page=&limit=&search=` | Receptionist, admin | Paginated identity directory. |
| `GET /api/patients/:id` | Receptionist/admin (identity only), linked patient (self) | Registration identity projection. |
| `GET /api/patients/:id/timeline?page=&limit=&from=&to=` | Patient self or doctor via patient-access policy | Doctors receive the authorized clinical timeline. Patient self-view is projected to visit summaries, completed lab results, and prescription regimen/status; internal notes, lab staff notes, prescription instructions, diagnoses, vitals, and referral details are omitted. AccessLog is required. |
| `POST /api/patients/:patientId/break-glass` | Doctor | `{ reason }`; starts server-timed 24-hour emergency authorization and notifies active admins. |
| `POST /api/encounters` | Receptionist, admin | `{ patient, department, visitType, chiefComplaint?, idempotencyKey }`. |
| `GET /api/departments` | Receptionist, admin | Returns active department names and codes for encounter selection. |
| `POST /api/departments` | Admin | Creates an active department with `{ name, code, description? }`; creation is audited. |
| `GET /api/encounters?page=&limit=` | Authenticated; service applies role/ownership policy | Visible encounter summaries. |
| `GET /api/patient-portal/doctors?page=&limit=&search=` | Active linked patient | Paginated active doctor directory. Returns only doctor account ID and full name for consent selection; name search is literal and bounded. |
| `GET /api/patient-portal/profile` | Patient | Minimal identity projection for the authenticated account's linked patient. Access is audited. |
| `GET /api/patient-portal/lab-results?page=&limit=` | Patient | Paginated completed laboratory results for the linked patient; excludes lab notes and unrelated clinical records. Access is audited. |
| `GET /api/patient-portal/prescriptions?page=&limit=` | Patient | Paginated prescription regimen and status for the linked patient; excludes clinician instructions. Access is audited. |
| `GET /api/patient-portal/summary.pdf` | Patient | Private, no-store PDF with the patient's own identity, visit summaries, completed lab results, and prescription summaries. No arbitrary patient ID is accepted. |
| `GET /api/encounters/:id` | Authenticated; service applies role/patient-access policy | Safe encounter detail. |
| `PATCH /api/encounters/:id/assign` | Admin | `{ doctorId, idempotencyKey }`. |
| `PATCH /api/encounters/:id/close` | Doctor | Closes an encounter assigned to the doctor. |
| `POST /api/encounters/:encounterId/vitals` | Doctor | Supported measurement fields plus required idempotency key; server calculates abnormal flags. |
| `GET /api/encounters/:encounterId/vitals` | Doctor | Vitals authorized by patient-access service. |
| `POST /api/encounters/:encounterId/diagnoses` | Doctor | `{ code?, description?, isPrimary?, idempotencyKey }`; coded diagnoses use the local FY2027 catalog when present. |
| `GET /api/encounters/:encounterId/diagnoses` | Doctor | Authorized encounter diagnoses. |
| `PATCH /api/encounters/:encounterId/notes` | Doctor | Allowlisted note, examination, assessment, plan, and follow-up fields. |
| `POST /api/encounters/:encounterId/prescriptions` | Doctor | Medication ID and dosing fields, required idempotency key; optional controlled allergy override fields. |
| `POST /api/encounters/:encounterId/lab-orders` | Doctor | `{ testName, components?, instructions?, priority?, idempotencyKey }`. |
| `PATCH /api/encounters/:encounterId/lab-orders/:orderId/cancel` | Doctor | Cancel eligible order. |
| `GET /api/lab/orders/pending?limit=` | Lab technician | Pending work queue. |
| `GET /api/lab/orders/:orderId` | Lab technician | Order and permitted context. |
| `POST /api/lab/orders/:orderId/results` | Lab technician | Result/component fields and idempotency key. |
| `PATCH /api/lab/orders/:orderId/reject-sample` | Lab technician | Meaningful rejection reason. |
| `GET /api/pharmacy/prescriptions/pending?page=&limit=` | Pharmacist | Paginated prescriptions eligible for further dispensing (pending/partial, positive remainder, active medication, valid patient/encounter link); includes patient identity projection, encounter/doctor identifiers, medication and dosing summary. Defaults to page 1 and 20 rows; maximum 100. |
| `GET /api/pharmacy/prescriptions/:prescriptionId` | Pharmacist | Safe prescription detail, current status/remaining quantity, `canDispense`, and dispense history; excludes clinical notes and allergy override metadata. |
| `GET /api/pharmacy/inventory/:medicationId` | Pharmacist | Medication inventory batches. |
| `POST /api/pharmacy/inventory/:inventoryId/stock` | Pharmacist | Positive quantity and idempotency key. |
| `POST /api/pharmacy/prescriptions/:prescriptionId/dispense` | Pharmacist | Inventory ID, quantity, idempotency key; requires transaction-capable MongoDB. |
| `POST /api/consents` | Patient | `{ doctorId, scope?, notes? }`; scope currently `clinical_record`. |
| `GET /api/consents` | Patient | Own consent records. |
| `PATCH /api/consents/:consentId/revoke` | Patient | Revoke own consent. |
| `POST /api/referrals` | Doctor | Encounter, destination/recipient fields supported by current service, reason, idempotency key. |
| `GET /api/referrals?encounterId=&page=&limit=` | Authenticated; service applies ownership/access | Visible referrals. |
| `GET /api/referrals/:id` | Authenticated; service applies ownership/access | Authorized referral detail. |
| `PATCH /api/referrals/:id/status` | Authenticated; service applies recipient/transition policy | `{ status, idempotencyKey }`. |
| `GET /api/notifications` | Authenticated | Notifications for the current recipient. |
| `PATCH /api/notifications/:id/read` | Authenticated | Mark own notification read; empty body. |
| `POST /api/payments` | Patient | Simulated payment initiation, idempotency key required. No real money is transferred. |
| `GET /api/payments?page=&limit=` | Patient | Own payment history. |
| `GET /api/payments/:paymentReference/status` | Patient | Own simulated status only. |
| `GET /api/fhir/Patient/:id` | Authenticated, patient-access policy | Read-only FHIR-style Patient. |
| `GET /api/fhir/Encounter/:id` | Authenticated, patient-access policy | Read-only FHIR-style Encounter. |
| `GET /api/fhir/Observation/:id` | Authenticated, patient-access policy | Read-only Vital or LabResult Observation. |
| `GET /api/fhir/MedicationRequest/:id` | Authenticated, patient-access policy | Read-only Prescription mapping. |
| `GET /api/admin/analytics?from=YYYY-MM-DD&to=YYYY-MM-DD` | Active admin | Bounded operational aggregate counts, not patient-level listings. |
| `GET /api/admin/access-logs?page=&limit=&patientId=&actorId=&fromDate=&toDate=` | Active admin | Read-only access-history review; safe projection. |
| `GET /api/admin/audit-logs?page=&limit=&actorId=&action=&entityType=&entityId=&fromDate=&toDate=` | Active admin | Read-only general audit review; safe projection. |
| `PATCH /api/admin/break-glass/:id/review` | Active admin | `{ decision: "justified"|"not_justified", notes? }`; self-review is denied. |
| `POST /api/admin/users` | Active admin | Managed user provisioning; admin bootstrap is intentionally not exposed. |
| `GET /api/admin/users?page=&limit=` | Active admin | Safe account projections. |
| `GET /api/admin/users/:userId` | Active admin | Safe account projection. |
| `PATCH /api/admin/users/:userId/status` | Active admin | `{ isActive, idempotencyKey }`; self-deactivation is denied. |

Strict allowlists reject unsupported request fields on protected write endpoints. Do not send server-managed identity, lifecycle, or audit fields. Clinical routes can return 401/403/404/409/413/503 depending on safe validation, access, conflict, partial-success, and availability conditions. For 503 partial-success responses, verify the named record before retrying and reuse the original idempotency key where provided.

## Example calls

```http
POST /api/auth/login
Content-Type: application/json

{"username":"demo_doctor","password":"<local-demo-password>"}
```

```http
POST /api/patients
Authorization: Bearer <token>
Content-Type: application/json

{"firstName":"Ayaan","fatherName":"Maxamed","grandfatherName":"Warsame","sex":"female","estimatedAge":32,"idempotencyKey":"demo-patient-000001"}
```

```http
POST /api/encounters
Authorization: Bearer <receptionist-token>
Content-Type: application/json

{"patient":"<patient-id>","department":"DEMO","visitType":"outpatient","chiefComplaint":"Demo visit","idempotencyKey":"demo-encounter-0001"}
```

Example standard response:

```json
{"success":true,"message":"Encounter created successfully","data":{"id":"<id>","visitNumber":"VISIT-000001","status":"open"}}
```

Example simulated payment response:

```json
{"success":true,"message":"Simulated payment request processed. No real money was transferred.","data":{"paymentReference":"SIM-<server-reference>","status":"simulated_success","provider":"simulated-mobile-money","simulated":true,"message":"This is a payment simulation; no real money was transferred."}}
```

Example FHIR-style error:

```json
{"resourceType":"OperationOutcome","issue":[{"severity":"error","code":"not-found","diagnostics":"FHIR resource was not found"}]}
```

FHIR resources use the FHIR media type and FHIR-style resource envelope; this is a partial mapping, not a conformance claim. Simulated payment responses explicitly indicate simulation; no SMS or payment provider is contacted.
