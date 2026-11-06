'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mongoose = require('mongoose');

const integrationUri = process.env.MONGO_INTEGRATION_URI;
const shouldRun = typeof integrationUri === 'string' && integrationUri.length > 0;

// Test-only secrets are scoped to this node:test worker and never printed.
process.env.PATIENT_IDENTITY_HMAC_SECRET = 'integration-test-only-patient-identity-key-32-bytes-minimum';
process.env.PAYMENT_FINGERPRINT_SECRET = 'integration-test-only-payment-fingerprint-key-32-bytes-minimum';

const { ensureIndexes } = require('../config/ensure-indexes');
const User = require('../models/User');
const Patient = require('../models/Patient');
const Encounter = require('../models/Encounter');
const Consent = require('../models/Consent');
const BreakGlass = require('../models/BreakGlass');
const Medication = require('../models/Medication');
const Inventory = require('../models/Inventory');
const Prescription = require('../models/Prescription');
const Dispense = require('../models/Dispense');
const Payment = require('../models/Payment');
const AuditLog = require('../models/AuditLog');
const InventoryStockAddition = require('../models/InventoryStockAddition');
const PatientRegistrationOperation = require('../models/PatientRegistrationOperation');
const { registerPatient } = require('../services/patient.service');
const { addInventoryStock, dispensePrescription } = require('../services/pharmacy.service');
const { initiatePatientPayment } = require('../services/payment.service');
const { revokePatientConsent } = require('../services/consent.service');
const { expireBreakGlassAuthorizations } = require('../services/break-glass-expiration.service');
const { writeAuditLog } = require('../services/audit-log.service');
const { createNotificationOnce } = require('../services/notification.service');

const runSuffix = `${process.pid}_${crypto.randomBytes(5).toString('hex')}`;
let isolatedDatabaseName;
let replicaSetAvailable = false;

function assertDedicatedTestUri(uri) {
  let parsed;
  try {
    parsed = new URL(uri);
  } catch (_) {
    throw new Error('MONGO_INTEGRATION_URI must be a valid MongoDB URI');
  }
  if (!['mongodb:', 'mongodb+srv:'].includes(parsed.protocol)) {
    throw new Error('MONGO_INTEGRATION_URI must use MongoDB protocol');
  }
  const configuredDatabase = decodeURIComponent(parsed.pathname.replace(/^\//, '').split('/')[0] || '');
  if (!/test|integration/i.test(configuredDatabase) || /prod|production/i.test(configuredDatabase)) {
    throw new Error('MONGO_INTEGRATION_URI database name must explicitly identify a test or integration database');
  }
  return configuredDatabase;
}

function hasIndex(indexes, keys, options = {}) {
  return indexes.some((index) => {
    const sameKeys = JSON.stringify(Object.entries(index.key)) === JSON.stringify(Object.entries(keys));
    if (!sameKeys || Boolean(index.unique) !== Boolean(options.unique)) return false;
    if (options.name && index.name !== options.name) return false;
    if (options.partialFilterExpression &&
        JSON.stringify(index.partialFilterExpression) !== JSON.stringify(options.partialFilterExpression)) return false;
    return true;
  });
}

async function makeUser(role, extra = {}) {
  const id = new mongoose.Types.ObjectId();
  const user = new User({
    _id: id,
    fullName: `Integration ${role}`,
    username: `${role.slice(0, 10)}_${id.toString().slice(-12)}`,
    password: '$2b$12$integration-test-hash-placeholder',
    role,
    isActive: true,
    ...extra
  });
  await user.save();
  return user;
}

async function makePatient(registeredBy, suffix) {
  const patient = new Patient({
    mrn: `MRN-${String(900000 + (parseInt(suffix.slice(-4), 16) % 99999)).padStart(6, '0')}`,
    firstName: `Integration${suffix}`,
    fatherName: 'Test',
    grandfatherName: 'Patient',
    sex: 'female',
    dateOfBirth: new Date('1990-01-01T00:00:00.000Z'),
    registeredBy
  });
  await patient.save();
  return patient;
}

test('isolated MongoDB reliability integration suite', { skip: !shouldRun }, async (t) => {
  const baseDatabaseName = assertDedicatedTestUri(integrationUri);
  isolatedDatabaseName = `${baseDatabaseName}_run_${runSuffix}`;
  await mongoose.connect(integrationUri, {
    dbName: isolatedDatabaseName,
    serverSelectionTimeoutMS: 4000,
    maxPoolSize: 10
  });
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  replicaSetAvailable = Boolean(hello.setName || hello.msg === 'isdbgrid');

  await t.after(async () => {
    if (mongoose.connection.readyState === 1) {
      // This exact database name was generated above and is dedicated to this run.
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  const readiness = await ensureIndexes();
  assert.equal(readiness.modelCount, 22);

  await t.test('creates declared indexes and enforces actual unique and partial indexes', async () => {
    const expected = [
      [User, { username: 1 }, { unique: true }],
      [User, { patient: 1 }, { unique: true, name: 'unique_patient_portal_account' }],
      [Patient, { mrn: 1 }, { unique: true }],
      [Patient, { identityPhoneKey: 1 }, { unique: true, name: 'unique_patient_normalized_phone' }],
      [Encounter, { visitNumber: 1 }, { unique: true }],
      [Encounter, { patient: 1, openedAt: -1, _id: -1 }, { name: 'encounters_by_patient_opened_at' }],
      [Encounter, { assignedDoctor: 1, openedAt: -1, _id: -1 }, { name: 'encounters_by_doctor_opened_at' }],
      [Consent, { patient: 1, doctor: 1 }, { unique: true, name: 'one_active_consent_per_patient_doctor' }],
      [require('../models/LabOrder'), { status: 1, technician: 1, orderedAt: 1, _id: 1 }, { name: 'pending_lab_work_queue' }],
      [Inventory, { medication: 1, batchNumber: 1 }, { unique: true, name: 'unique_batch_per_medication' }],
      [InventoryStockAddition, { actor: 1, idempotencyKeyHash: 1 }, { unique: true, name: 'unique_inventory_stock_addition_per_actor_key' }],
      [PatientRegistrationOperation, { actor: 1, idempotencyKeyHash: 1 }, { unique: true, name: 'unique_patient_registration_per_actor_key' }],
      [Payment, { initiatingUser: 1, idempotencyKey: 1 }, { unique: true, name: 'unique_payment_idempotency_per_user' }],
      [Prescription, { medication: 1 }, {}],
      [AuditLog, { paymentDeduplicationKey: 1 }, { unique: true, name: 'unique_payment_audit_deduplication_key' }]
    ];

    for (const [model, keys, options] of expected) {
      const indexes = await model.collection.listIndexes().toArray();
      assert.equal(hasIndex(indexes, keys, options), true, `${model.modelName} index ${JSON.stringify(keys)} exists`);
    }

    const actor = await makeUser('doctor');
    const first = new User({ fullName: 'First', username: 'dupe_test_user', password: 'hash', role: 'doctor' });
    const second = new User({ fullName: 'Second', username: 'dupe_test_user', password: 'hash', role: 'doctor' });
    await first.save();
    await assert.rejects(second.save(), (error) => error.code === 11000);

    const patientId = new mongoose.Types.ObjectId();
    const consentInput = { patient: patientId, doctor: actor._id, grantedBy: new mongoose.Types.ObjectId() };
    await Consent.create(consentInput);
    await assert.rejects(Consent.create(consentInput), (error) => error.code === 11000);

    const registrar = await makeUser('receptionist');
    const sharedPhone = '+252611112222';
    const firstPatient = new Patient({
      mrn: 'MRN-000801', firstName: 'Duplicate', fatherName: 'Phone', grandfatherName: 'Index',
      sex: 'male', estimatedAge: 35, phone: sharedPhone, registeredBy: registrar._id
    });
    const duplicatePatient = new Patient({
      mrn: 'MRN-000802', firstName: 'Different', fatherName: 'Name', grandfatherName: 'SamePhone',
      sex: 'female', estimatedAge: 40, phone: sharedPhone, registeredBy: registrar._id
    });
    await firstPatient.save();
    await assert.rejects(duplicatePatient.save(), (error) => error.code === 11000);

    const medication = await Medication.create({
      name: `unique-index-med-${runSuffix}`, category: 'test', strength: '1 unit', dosageForm: 'tablet',
      route: 'oral', createdBy: actor._id
    });
    const inventoryValues = {
      medication: medication._id, batchNumber: `unique-batch-${runSuffix}`, quantity: 1, unit: 'tablets',
      expiryDate: new Date(Date.now() + 86400000 * 60), lastUpdatedBy: actor._id
    };
    await Inventory.create(inventoryValues);
    await assert.rejects(Inventory.create(inventoryValues), (error) => error.code === 11000);
    await assert.rejects(
      AuditLog.bulkWrite([{ updateOne: { filter: {}, update: { $set: { action: 'rewritten' } } } }]),
      /append-only/
    );
  });

  await t.test('concurrent patient registration retries reuse one patient, MRN, and audit record', async () => {
    const registrar = await makeUser('receptionist');
    const input = {
      idempotencyKey: `patient_${runSuffix}`,
      firstName: `Somali${runSuffix}`,
      fatherName: 'Integration',
      grandfatherName: 'Record',
      sex: 'female',
      dateOfBirth: '1989-04-03'
    };
    const outcomes = await Promise.all([
      registerPatient(input, { id: registrar._id.toString() }),
      registerPatient(input, { id: registrar._id.toString() })
    ]);
    assert.equal(outcomes[0].id, outcomes[1].id);
    assert.match(outcomes[0].mrn, /^MRN-\d{6}$/);
    assert.equal(await Patient.countDocuments({ _id: outcomes[0].id }), 1);
    assert.equal(await PatientRegistrationOperation.countDocuments({ patient: outcomes[0].id }), 1);
    assert.equal(await AuditLog.countDocuments({ action: 'patient_registered', entityId: outcomes[0].id }), 1);
    await assert.rejects(
      registerPatient({ ...input, idempotencyKey: `${input.idempotencyKey}_other`, firstName: `${input.firstName} ` }, { id: registrar._id.toString() }),
      (error) => error.status === 409
    );
  });

  await t.test('concurrent inventory stock retries apply one atomic stock addition and one audit event', async () => {
    const pharmacist = await makeUser('pharmacist');
    const medication = await Medication.create({
      name: `integration-med-${runSuffix}`, category: 'test', strength: '1 unit', dosageForm: 'tablet',
      route: 'oral', createdBy: pharmacist._id, isActive: true
    });
    const inventory = await Inventory.create({
      medication: medication._id, batchNumber: `batch-${runSuffix}`, quantity: 5, minimumStock: 1,
      unit: 'tablets', expiryDate: new Date(Date.now() + 86400000 * 90), lastUpdatedBy: pharmacist._id
    });
    const input = { inventoryId: inventory._id.toString(), quantity: 4, idempotencyKey: `stock_${runSuffix}` };
    await Promise.all([
      addInventoryStock(input, { id: pharmacist._id.toString() }),
      addInventoryStock(input, { id: pharmacist._id.toString() })
    ]);
    const current = await Inventory.findById(inventory._id).lean();
    assert.equal(current.quantity, 9);
    assert.equal(await InventoryStockAddition.countDocuments({ actor: pharmacist._id }), 1);
    assert.equal(await AuditLog.countDocuments({ action: 'inventory_stock_added', entityId: inventory._id }), 1);
  });

  await t.test('concurrent patient payment retries persist one payment and deduplicated audit events', async () => {
    const registrar = await makeUser('receptionist');
    const patient = await makePatient(registrar._id, runSuffix);
    const portal = await makeUser('patient', { patient: patient._id });
    const input = {
      phoneNumber: '+252612345678', amount: 2.5, currency: 'USD', idempotencyKey: `payment_${runSuffix}`
    };
    const outcomes = await Promise.all([
      initiatePatientPayment(input, { id: portal._id.toString() }),
      initiatePatientPayment(input, { id: portal._id.toString() })
    ]);
    assert.equal(outcomes[0].paymentReference, outcomes[1].paymentReference);
    assert.equal(await Payment.countDocuments({ initiatingUser: portal._id }), 1);
    const payment = await Payment.findOne({ initiatingUser: portal._id });
    assert.ok(['simulated_success', 'pending', 'simulated_failed'].includes(payment.status));
    assert.equal(await AuditLog.countDocuments({ entityType: 'Payment', entityId: payment._id }), payment.status === 'pending' ? 1 : 2);

    const eventId = new mongoose.Types.ObjectId();
    const deduplicationKey = crypto.createHash('sha256').update(`payment-audit:${runSuffix}`).digest('hex');
    const inputAudit = {
      actorId: portal._id,
      action: 'payment_initiated',
      entityType: 'Payment',
      entityId: eventId,
      paymentDeduplicationKey: deduplicationKey
    };
    await Promise.all([writeAuditLog(inputAudit), writeAuditLog(inputAudit)]);
    assert.equal(await AuditLog.countDocuments({ paymentDeduplicationKey: deduplicationKey }), 1);
  });

  await t.test('notification event retries use a durable deterministic identifier', async () => {
    const admin = await makeUser('admin');
    const event = {
      recipient: admin._id,
      type: 'general',
      title: 'Integration event',
      message: 'A synthetic notification for the isolated integration test.',
      eventKey: `notification_${runSuffix}`
    };
    const first = await createNotificationOnce(event);
    const replay = await createNotificationOnce(event);
    assert.equal(first.id, replay.id);
    assert.equal(replay.replayed, true);
    assert.equal(await require('../models/Notification').countDocuments({ _id: first.id }), 1);
  });

  await t.test('persisted consent revocation and BreakGlass expiry take effect', async () => {
    const registrar = await makeUser('receptionist');
    const patient = await makePatient(registrar._id, `${runSuffix}a`);
    const portal = await makeUser('patient', { patient: patient._id });
    const doctor = await makeUser('doctor');
    const consent = await Consent.create({ patient: patient._id, doctor: doctor._id, grantedBy: portal._id });
    await revokePatientConsent(consent._id.toString(), { id: portal._id.toString() });
    const persistedConsent = await Consent.findById(consent._id).lean();
    assert.equal(persistedConsent.status, 'revoked');
    assert.ok(persistedConsent.revokedAt instanceof Date);

    const activatedAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const expiredCandidate = await BreakGlass.create({
      patient: patient._id,
      doctor: doctor._id,
      reason: 'Integration test emergency authorization reason',
      status: 'active',
      activatedAt,
      expiresAt: new Date(activatedAt.getTime() + 24 * 60 * 60 * 1000)
    });
    const result = await expireBreakGlassAuthorizations();
    assert.ok(result.expiredCount >= 1);
    assert.equal((await BreakGlass.findById(expiredCandidate._id).lean()).status, 'expired');
  });

  await t.test('dispensing either commits consistently on transaction-capable MongoDB or fails closed on standalone MongoDB', async () => {
    const registrar = await makeUser('receptionist');
    const doctor = await makeUser('doctor');
    const pharmacist = await makeUser('pharmacist');
    const patient = await makePatient(registrar._id, `${runSuffix}b`);
    const encounter = await Encounter.create({
      patient: patient._id, visitNumber: `INT-${runSuffix}`, department: 'OPD',
      assignedDoctor: doctor._id, visitType: 'outpatient', status: 'in_progress'
    });
    const medication = await Medication.create({
      name: `dispense-med-${runSuffix}`, category: 'test', strength: '1 unit', dosageForm: 'tablet',
      route: 'oral', createdBy: doctor._id, isActive: true
    });
    const inventory = await Inventory.create({
      medication: medication._id, batchNumber: `dispense-batch-${runSuffix}`, quantity: 6, minimumStock: 1,
      unit: 'tablets', expiryDate: new Date(Date.now() + 86400000 * 90), lastUpdatedBy: pharmacist._id
    });
    const prescription = await Prescription.create({
      patient: patient._id, encounter: encounter._id, doctor: doctor._id,
      medication: medication._id, drugName: medication.name, dose: '1 unit', route: 'oral', frequency: 'daily', duration: 3, quantity: 3
    });
    const request = {
      prescriptionId: prescription._id.toString(), inventoryId: inventory._id.toString(),
      quantity: 2, idempotencyKey: `dispense_${runSuffix}`
    };

    if (!replicaSetAvailable) {
      await assert.rejects(dispensePrescription(request, { id: pharmacist._id.toString() }), (error) => error.transactionUnavailable === true);
      assert.equal((await Inventory.findById(inventory._id).lean()).quantity, 6);
      assert.equal(await Dispense.countDocuments({ prescription: prescription._id }), 0);
      return;
    }

    const result = await dispensePrescription(request, { id: pharmacist._id.toString() });
    assert.equal(result.quantityDispensed, 2);
    assert.equal((await Inventory.findById(inventory._id).lean()).quantity, 4);
    assert.equal((await Prescription.findById(prescription._id).lean()).status, 'partially_dispensed');
    assert.equal(await Dispense.countDocuments({ prescription: prescription._id }), 1);
  });
});
