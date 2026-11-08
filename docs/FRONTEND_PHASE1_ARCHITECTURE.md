# Frontend Phase 1: Architecture and API Contract Plan

Status: inspection and planning only. No frontend application has been created in this phase.

## Repository findings

The repository is a Node.js 22, Express 5, and Mongoose backend. Root `package.json` contains only the backend runtime and test dependencies/scripts. There is no React/Vue/Angular project, frontend source directory, browser build configuration, or frontend dependency set. Backend routes are mounted from `server/app.js` under `/api`; `docs/API.md` is the current API guide.

Keep the backend package and its lockfile dedicated to the API. When implementation begins, create an isolated `client/` application using React and Vite with JavaScript/JSX. Add only the React runtime, Vite, and a router dependency (`react-router-dom`) unless an implementation requirement justifies another package. Keep translations in application-owned dictionaries rather than adding an i18n framework for the initial language scope.

## API behavior the frontend must follow

- Login is `POST /api/auth/login` with `{ username, password }`. Success is HTTP 200 with `{ success, message, data: { token, user } }`.
- Authenticated requests use `Authorization: Bearer <token>`. The API resolves current role and active status from MongoDB on each request. A previously issued token stops working after account deactivation. There is no refresh-token or server logout endpoint.
- Normal JSON responses use `{ success: boolean, message: string, data: object|null }`. Error status codes include 400, 401, 403, 404, 409, 413, 429, 500, and 503. Login throttling returns 429 and `Retry-After`.
- A 503 may represent partial success; `data` can carry `partialSuccess` and a record identifier. Show the uncertain state and offer verification/retry with the same idempotency key. Do not automatically submit a fresh key.
- FHIR-style GETs return FHIR resources or `OperationOutcome` objects rather than the normal envelope. Keep those responses behind a separate client parser if the FHIR pages use them.
- Send `Accept-Language: en` or `so`. API fields, IDs, and enum values remain stable. Some Somali success/error messages are translated server-side; the frontend still needs its own dictionary for navigation, labels, form help, empty states, and other UI copy.
- There is no CORS middleware in `server/app.js`. Use the Vite development proxy for `/api` and deploy behind a same-origin reverse proxy until an explicit CORS policy is part of backend deployment configuration.

## Actual role and permission map

Server-side authorization remains the source of truth. Frontend role checks only shape navigation and prevent confusing actions; they do not grant API access.

| Role | Supported frontend modules and actions |
| --- | --- |
| `admin` | Operational analytics; provision/list/view users and update account status; review audit/access logs and BreakGlass; register patients and create encounters; assign encounters to doctors. Admin does not receive general clinical-record access. Admin account bootstrap is not exposed as an API. |
| `receptionist` | Register patients; search/list the identity directory; view identity-only patient details; create encounters. Reception cannot read the clinical timeline, vitals, notes, or other restricted clinical records. Reception cannot assign encounters. |
| `doctor` | List/view encounters assigned to that doctor; read authorized patient timelines; add vitals, notes, diagnoses, prescriptions, lab orders, and referrals; activate BreakGlass. Patient access depends on assignment, consent, or active BreakGlass. Doctors cannot create or assign encounters. |
| `lab_technician` | Read the pending lab queue/order details; record results; reject samples. |
| `pharmacist` | Look up inventory by medication ID; add stock; dispense prescriptions. Dispensing needs a transaction-capable MongoDB deployment. |
| `patient` | Access own identity/timeline/encounters and referrals; manage own doctor consent; use own simulated payments; read own notifications. Patient ownership is enforced by the API. |

All six roles can load `/api/protected/profile` and their own notification inbox/read state. Referral APIs are narrower than their route middleware: the service permits patient/doctor reads and doctor writes, with ownership, assignment, consent, BreakGlass, and referral-recipient rules applied by the service.

## Proposed frontend structure

```text
client/
  index.html
  package.json
  vite.config.js
  src/
    main.jsx
    app/
      App.jsx
      router.jsx
      roleRoutes.js
    auth/
      AuthProvider.jsx
      RequireAuth.jsx
      RequireRole.jsx
      authStorage.js
    api/
      httpClient.js
      apiErrors.js
      fhirClient.js
    i18n/
      LanguageProvider.jsx
      messages.en.js
      messages.so.js
    layouts/
      AppShell.jsx
      RoleNavigation.jsx
      PageHeader.jsx
    components/
      Button.jsx
      FormField.jsx
      InlineError.jsx
      LoadingState.jsx
      EmptyState.jsx
      ConfirmDialog.jsx
      Pagination.jsx
      StatusBadge.jsx
      LanguageToggle.jsx
    pages/
      auth/LoginPage.jsx
      admin/{Analytics,Users,AuditLogs,AccessLogs,BreakGlassReview}Page.jsx
      receptionist/{PatientRegistration,PatientDirectory,EncounterCheckIn}Page.jsx
      doctor/{AssignedEncounters,PatientTimeline,EncounterWorkspace}Page.jsx
      lab/{WorkQueue,OrderResults}Page.jsx
      pharmacy/{Inventory,Dispense}Page.jsx
      patient/{Portal,Consent,Payments,Referrals}Page.jsx
    styles/
      tokens.css
      global.css
      responsive.css
```

The role navigation should be driven by a small explicit configuration keyed by the six backend role strings. Use a shared shell and reusable components, while keeping pages and API calls grouped by role/module. Avoid duplicating the authorization matrix across individual page conditionals.

## Client behavior and layout guidance

- `AuthProvider` owns the current user and bearer token. Store the token only for the browser session, clear it on logout or HTTP 401, and use the profile endpoint to validate restored session state. The API remains authoritative if a role changes or an account is disabled.
- `httpClient` centralizes base URL, bearer header, `Accept-Language`, JSON parsing, and error normalization. Handle FHIR `OperationOutcome` separately. Preserve status, message, partial-success metadata, and `Retry-After` for page-level handling.
- Keep idempotency keys attached to a submitted operation until a definitive response is received. For 503 partial success, let the page verify/retry the same operation; do not create a duplicate with a new key.
- Keep language selection and UI translations separate from API data. Somali and English use left-to-right layout; localize dates and numbers while leaving API enum/code values unchanged.
- Desktop: persistent collapsible side navigation and readable data tables. Tablet: compact navigation and horizontally safe detail layouts. Mobile: drawer/bottom-level navigation and tables adapted to stacked cards. Forms should remain usable without hover and support keyboard focus.
- Keep clinical values out of browser storage and console output. Only session authentication state and language preference need client persistence.

## Recommended implementation sequence

1. Resolve the API gaps listed below or agree on explicit temporary UX fallbacks.
2. Scaffold `client/` with React/Vite, a `/api` development proxy, responsive base styles, and English/Somali UI dictionaries.
3. Implement the API client, auth provider, login, profile validation, and protected/role route wrappers.
4. Build the shared shell, role navigation, loading/error/empty states, reusable forms, and mobile/tablet navigation.
5. Implement reception and admin setup workflows: patient registration/directory, encounter creation, assignment, user administration.
6. Implement doctor workflows for assigned encounters and patient records: timeline, notes, vitals, diagnoses, prescriptions, labs/referrals, BreakGlass.
7. Implement lab work queue/results and pharmacy inventory/dispensing.
8. Implement patient portal: self timeline, consent, referrals, payments, notifications.
9. Verify each screen against the real API with role-specific accounts, including denied paths and 503 partial-success recovery.

## API contract gaps before full integration

1. **Medication catalog lookup is missing.** Prescription and inventory flows require `medicationId`, but there is no route to search/list active medications. The pharmacy inventory route also requires a known medication ID.
2. **Department lookup is missing.** Encounter creation requires a department name/code and the service requires it to resolve to an active Department, but no API route lists departments.
3. **Allergy read/management is missing.** The model exists and registration can capture allergy strings, but there is no allergy endpoint. The patient timeline does not include allergy records, leaving no clinician UI route to review the full allergy record before prescribing.
4. **ICD-10 catalog search is missing.** Diagnosis creation validates codes against the local FY2027 catalog, but that catalog has no API search/lookup route.
5. **Diagnosis request documentation is incomplete.** `POST /api/encounters/:encounterId/diagnoses` requires `patient` in the actual service input, but `docs/API.md` omits it. The client can send the patient ID from its selected encounter; the API guide/contract should be corrected.
6. **Payment reference example is inaccurate.** The API guide shows `SIM-...`, while the payment model/service use a `pay-<UUID>` reference and validate that shape. The UI must use the returned value verbatim; documentation should be aligned.
7. **Encounter creation ownership needs a UI flow.** Only receptionist/admin may create an encounter and only admin may assign a doctor. There is no doctor-create route. The UI must model reception check-in followed by admin assignment.
8. **No refresh/logout endpoint or expiry metadata.** Login returns a JWT with an embedded expiration but no refresh contract. The client should clear expired/401 sessions and require login again.
9. **No API CORS configuration.** Use a same-origin proxy for development and deployment, or add an explicit allowlist as a separately approved backend deployment change before cross-origin hosting.

