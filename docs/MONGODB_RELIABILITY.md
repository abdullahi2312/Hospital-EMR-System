# MongoDB index deployment and integration tests

## Index readiness

The server now loads all 22 Mongoose models and awaits `Model.createIndexes()` after MongoDB connects and before startup maintenance or HTTP listening. `createIndexes()` creates or verifies indexes declared by each schema; it does not drop indexes or synchronize collections. Startup fails closed if index creation fails, and the log names the affected model without printing the URI or database error details.

For a controlled index deployment, configure `MONGO_URI` for the intended environment and run:

```powershell
npm run db:indexes
```

Review the target database and take the deployment backup required by your operations process first. A unique index can fail if historical rows contain duplicate values. The application intentionally does not delete, merge, or rewrite those rows and does not drop conflicting indexes. Resolve duplicates through an approved migration, then rerun index deployment. Pay special attention to `Patient` MRN and identity keys, `User.username` and linked patient accounts, `Encounter.visitNumber`, active `Consent` pairs, primary `Diagnosis` per encounter, `Inventory` medication/batch, `LabResult` order/component, payment and operation idempotency keys, and partial unique `AuditLog` keys. Current production duplicates have not been scanned in this workspace.

Use schema index declarations as the source of truth. To inspect actual deployed indexes without altering them, use MongoDB `listIndexes` on each model collection or Mongoose `Model.collection.listIndexes().toArray()`. The query audit added owner-plus-`openedAt` compound indexes for Encounter lists/timelines and a compound pending LabOrder work-queue index. Encounter's former standalone patient and assigned-doctor declarations were removed because those query paths are covered by the new compound prefixes. Since the deployment path never drops indexes, review any existing standalone Encounter indexes manually after verifying query plans; do not remove them automatically.

## Isolated MongoDB integration suite

The integration suite is opt-in and never reads `MONGO_URI`. Provide `MONGO_INTEGRATION_URI` with a database path whose name contains `test` or `integration`; the suite creates a unique run-specific database name from that base and rejects production-like names. It creates declared indexes, exercises real model/service operations, and drops only the unique database it generated for that test run. It does not use or drop the database named directly in the URI.

Example with a local MongoDB instance:

```powershell
$env:MONGO_INTEGRATION_URI = 'mongodb://127.0.0.1:27017/hospital_emr_test'
npm run test:integration
Remove-Item Env:\MONGO_INTEGRATION_URI
```

The suite checks deployed unique indexes and duplicate-key behavior, concurrent patient registration replay, concurrent stock-add replay, payment idempotency and audit deduplication, durable notification retry, persisted consent revocation, BreakGlass expiry, and dispensing consistency. Dispensing requires a replica set or sharded cluster. On a standalone server, the suite verifies that dispensing fails closed with no inventory or dispense mutation; it does not claim successful transactional dispensing was tested.

## Local single-node replica set for transaction testing

Use a disposable local MongoDB instance and a test-only database. Never convert or reconfigure a shared/production MongoDB deployment for this test. For an installed local `mongod`, run it in a dedicated terminal with a separate local data directory:

```powershell
mongod --replSet rs0 --bind_ip 127.0.0.1 --port 27018 --dbpath C:\temp\hospital-emr-rs0
```

In another terminal, initialize the single-node set once:

```powershell
mongosh --host 127.0.0.1 --port 27018 --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27018"}]})'
```

Wait until `rs.status()` reports a PRIMARY, then run the isolated suite with a replica-set URI:

```powershell
$env:MONGO_INTEGRATION_URI = 'mongodb://127.0.0.1:27018/hospital_emr_test?replicaSet=rs0'
npm run test:integration
Remove-Item Env:\MONGO_INTEGRATION_URI
```

The integration test itself creates a unique generated database and drops only that generated test database. The single-node setup is suitable for local API/transaction testing, not production availability. The current workspace MongoDB is standalone, so successful transaction commits have not been verified here.

The regular `npm test` command runs all unit tests and the integration file. Without `MONGO_INTEGRATION_URI`, the integration suite is reported as skipped. No in-memory MongoDB package is installed or used.
