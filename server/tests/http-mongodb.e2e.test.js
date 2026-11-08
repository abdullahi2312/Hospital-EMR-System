'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mongoose = require('mongoose');

const integrationUri = process.env.MONGO_INTEGRATION_URI;
const shouldRun = typeof integrationUri === 'string' && integrationUri.length > 0;
const runSuffix = `${process.pid}_${crypto.randomBytes(5).toString('hex')}`;

process.env.PATIENT_IDENTITY_HMAC_SECRET = 'http-e2e-test-only-patient-identity-key-32-bytes-minimum';
process.env.PAYMENT_FINGERPRINT_SECRET = 'http-e2e-test-only-payment-fingerprint-key-32-bytes-minimum';
process.env.JWT_SECRET = crypto.randomBytes(48).toString('base64url');
process.env.JWT_EXPIRES_IN = '1h';

const { ensureIndexes } = require('../config/ensure-indexes');
const app = require('../app');
const { hashPassword } = require('../utils/password');
const User = require('../models/User');
const Patient = require('../models/Patient');
const PatientRegistrationOperation = require('../models/PatientRegistrationOperation');
const Encounter = require('../models/Encounter');
const Department = require('../models/Department');
const Allergy = require('../models/Allergy');
const Medication = require('../models/Medication');
const Prescription = require('../models/Prescription');
const Vital = require('../models/Vital');
const Diagnosis = require('../models/Diagnosis');
const LabOrder = require('../models/LabOrder');
const LabResult = require('../models/LabResult');
const Inventory = require('../models/Inventory');
const Dispense = require('../models/Dispense');
const Consent = require('../models/Consent');
const BreakGlass = require('../models/BreakGlass');
const Referral = require('../models/Referral');
const Notification = require('../models/Notification');
const Payment = require('../models/Payment');
const AuditLog = require('../models/AuditLog');
const AccessLog = require('../models/AccessLog');
const { expireBreakGlassAuthorizations } = require('../services/break-glass-expiration.service');

function dedicatedLocalDatabase(uri) {
  let parsed;
  try {
    parsed = new URL(uri);
  } catch (_) {
    throw new Error('MONGO_INTEGRATION_URI must be a valid MongoDB URI');
  }
  if (parsed.protocol !== 'mongodb:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
    throw new Error('HTTP E2E tests require a local MongoDB URI');
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, '').split('/')[0] || '');
  if (!/test|integration/i.test(databaseName) || /prod|production/i.test(databaseName)) {
    throw new Error('MONGO_INTEGRATION_URI database name must identify a test or integration database');
  }
  return databaseName;
}

async function createHttpUser(role, passwordHash, patient) {
  const suffix = crypto.randomBytes(5).toString('hex');
  const user = await User.create({
    fullName: `HTTP E2E ${role}`,
    username: `e2e_${role}_${suffix}`,
    password: passwordHash,
    role,
    isActive: true,
    ...(patient ? { patient: patient._id } : {})
  });
  return user;
}

async function request(baseUrl, path, { token, method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  const payload = await response.json();
  return { status: response.status, body: payload };
}

async function login(baseUrl, user, password) {
  const result = await request(baseUrl, '/api/auth/login', {
    method: 'POST', body: { username: user.username, password }
  });
  assert.equal(result.status, 200, `login for ${user.role}: ${result.body.message}`);
  assert.equal(result.body.success, true);
  assert.equal(result.body.data.user.role, user.role);
  return result.body.data.token;
}

test('real Express HTTP to isolated MongoDB end-to-end workflows', { skip: !shouldRun }, async (t) => {
  const baseDatabaseName = dedicatedLocalDatabase(integrationUri);
  const databaseName = `${baseDatabaseName}_http_e2e_${runSuffix}`;
  let httpServer;
  let baseUrl;
  let dbConnected = false;

  try {
    await mongoose.connect(integrationUri, {
      dbName: databaseName,
      serverSelectionTimeoutMS: 5000,
      maxPoolSize: 12
    });
    dbConnected = true;
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    assert.ok(hello.setName || hello.msg === 'isdbgrid', 'E2E database must support transactions');
    await ensureIndexes();

    httpServer = app.listen(0);
    await new Promise((resolve, reject) => {
      httpServer.once('listening', resolve);
      httpServer.once('error', reject);
    });
    const address = httpServer.address();
    baseUrl = `http://127.0.0.1:${address.port}`;

    const password = 'HttpE2e-Synthetic-Password-2026';
    const passwordHash = await hashPassword(password);
    const users = {};
    for (const role of ['admin', 'receptionist', 'doctor', 'lab_technician', 'pharmacist']) {
      users[role] = await createHttpUser(role, passwordHash);
    }
    const tokens = {};
    for (const role of ['admin', 'receptionist', 'doctor', 'lab_technician', 'pharmacist']) {
      tokens[role] = await login(baseUrl, users[role], password);
    }

    const testContext = {};
    await t.test('all six role accounts authenticate through the real login endpoint', async () => {
      const registrationBody = {
        firstName: `Ayaan${runSuffix}`,
        fatherName: 'Synthetic',
        grandfatherName: 'Patient',
        sex: 'female',
        estimatedAge: 31,
        phone: '252612345678',
        allergies: ['penicillin'],
        allergyStatus: 'recorded',
        idempotencyKey: `patient-${runSuffix}`
      };
      const originalPatientSave = Patient.prototype.save;
      let loseSaveAcknowledgement = true;
      Patient.prototype.save = async function saveWithLostFirstAcknowledgement(...args) {
        const saved = await originalPatientSave.apply(this, args);
        if (loseSaveAcknowledgement) {
          loseSaveAcknowledgement = false;
          throw new Error('Simulated HTTP confirmation loss after MongoDB patient insert');
        }
        return saved;
      };
      let uncertainRegistration;
      try {
        uncertainRegistration = await request(baseUrl, '/api/patients', {
          token: tokens.receptionist,
          method: 'POST',
          body: registrationBody
        });
      } finally {
        Patient.prototype.save = originalPatientSave;
      }
      assert.equal(uncertainRegistration.status, 503);

      const registration = await request(baseUrl, '/api/patients', {
        token: tokens.receptionist,
        method: 'POST',
        body: registrationBody
      });
      assert.equal(registration.status, 201, registration.body.message);
      assert.equal(registration.body.success, true);
      assert.match(registration.body.data.mrn, /^MRN-\d{6}$/);
      const replay = await request(baseUrl, '/api/patients', {
        token: tokens.receptionist,
        method: 'POST',
        body: registrationBody
      });
      assert.equal(replay.status, 201, replay.body.message);
      assert.equal(replay.body.data.id, registration.body.data.id);
      assert.equal(replay.body.data.mrn, registration.body.data.mrn);
      const changedPayload = await request(baseUrl, '/api/patients', {
        token: tokens.receptionist,
        method: 'POST',
        body: { ...registrationBody, firstName: `${registrationBody.firstName}Changed` }
      });
      assert.equal(changedPayload.status, 409);
      assert.equal(await Patient.countDocuments({ _id: registration.body.data.id }), 1);
      assert.equal(await PatientRegistrationOperation.countDocuments({ patient: registration.body.data.id }), 1);
      assert.equal(await AuditLog.countDocuments({ action: 'patient_registered', entityId: registration.body.data.id }), 1);
      const mrnSequence = await mongoose.connection.db.collection('hospital_emr_sequences').findOne({ _id: 'patient_mrn_sequence' });
      assert.equal(mrnSequence.sequence, 1);
      testContext.patientId = registration.body.data.id;
      testContext.mrn = registration.body.data.mrn;
      testContext.patientPhone = '252612345678';

      const patient = await Patient.findById(testContext.patientId).lean();
      assert.ok(patient);
      assert.equal(patient.mrn, testContext.mrn);
      assert.deepEqual(patient.allergies, ['penicillin']);
      assert.equal(await AuditLog.countDocuments({ action: 'patient_registered', entityId: patient._id }), 1);

      testContext.patientUser = await createHttpUser('patient', passwordHash, patient);
      const patientLogin = await request(baseUrl, '/api/auth/patient-login', {
        method: 'POST', body: { mrn: testContext.mrn.toLowerCase(), phone: '+252 (61) 234-5678', password }
      });
      assert.equal(patientLogin.status, 200, patientLogin.body.message);
      assert.equal(patientLogin.body.data.user.role, 'patient');
      assert.equal(patientLogin.body.data.user.patient, patient._id.toString());
      assert.equal(Object.hasOwn(patientLogin.body.data.user, 'password'), false);
      testContext.patientToken = patientLogin.body.data.token;
      users.patient = testContext.patientUser;
      tokens.patient = testContext.patientToken;

      const unauthed = await request(baseUrl, `/api/patients/${patient._id}/timeline`);
      assert.equal(unauthed.status, 401);
      const receptionistTimeline = await request(baseUrl, `/api/patients/${patient._id}/timeline`, { token: tokens.receptionist });
      assert.equal(receptionistTimeline.status, 403);
      const badPatientLogin = await request(baseUrl, '/api/auth/patient-login', {
        method: 'POST', body: { mrn: testContext.mrn, phone: '252600000000', password }
      });
      assert.equal(badPatientLogin.status, 401);
    });

    await t.test('reception encounter creation, admin assignment, and authorized doctor clinical documentation persist', async () => {
      const departmentCreated = await request(baseUrl, '/api/departments', {
        token: tokens.admin,
        method: 'POST',
        body: { name: `E2E General ${runSuffix}`, code: `E2E${Date.now().toString().slice(-8)}` }
      });
      assert.equal(departmentCreated.status, 201, departmentCreated.body.message);
      const department = departmentCreated.body.data.department;
      testContext.departmentId = department.id;
      const departmentList = await request(baseUrl, '/api/departments', { token: tokens.receptionist });
      assert.equal(departmentList.status, 200);
      assert.ok(departmentList.body.data.departments.some((item) => item.id === department.id));
      const departmentDenied = await request(baseUrl, '/api/departments', { token: tokens.doctor });
      assert.equal(departmentDenied.status, 403);
      assert.ok(await AuditLog.exists({ action: 'department_created', entityType: 'Department', entityId: department.id }));
      const doctorCreateDenied = await request(baseUrl, '/api/encounters', {
        token: tokens.doctor,
        method: 'POST',
        body: {
          patient: testContext.patientId,
          department: department.code,
          visitType: 'outpatient',
          idempotencyKey: `doctor-encounter-${runSuffix}`
        }
      });
      assert.equal(doctorCreateDenied.status, 403);

      const created = await request(baseUrl, '/api/encounters', {
        token: tokens.receptionist,
        method: 'POST',
        body: {
          patient: testContext.patientId,
          department: department.code,
          visitType: 'outpatient',
          chiefComplaint: 'Synthetic cough evaluation',
          idempotencyKey: `encounter-${runSuffix}`
        }
      });
      assert.equal(created.status, 201, created.body.message);
      testContext.encounterId = created.body.data.id;
      assert.ok(await Encounter.exists({ _id: testContext.encounterId, patient: testContext.patientId }));

      const receptionistClinical = await request(baseUrl, `/api/patients/${testContext.patientId}/timeline`, { token: tokens.receptionist });
      assert.equal(receptionistClinical.status, 403);

      const assigned = await request(baseUrl, `/api/encounters/${testContext.encounterId}/assign`, {
        token: tokens.admin,
        method: 'PATCH',
        body: { doctorId: users.doctor._id.toString(), idempotencyKey: `assign-${runSuffix}` }
      });
      assert.equal(assigned.status, 200, assigned.body.message);
      assert.equal(String((await Encounter.findById(testContext.encounterId).lean()).assignedDoctor), String(users.doctor._id));

      const doctorTimeline = await request(baseUrl, `/api/patients/${testContext.patientId}/timeline`, { token: tokens.doctor });
      assert.equal(doctorTimeline.status, 200, doctorTimeline.body.message);
      assert.ok(await AccessLog.exists({ patient: testContext.patientId, user: users.doctor._id, accessMethod: 'assigned_visit' }));

      const vitals = await request(baseUrl, `/api/encounters/${testContext.encounterId}/vitals`, {
        token: tokens.doctor,
        method: 'POST',
        body: {
          patient: testContext.patientId,
          bloodPressure: { systolic: 118, diastolic: 76 },
          temperature: 37.1,
          pulse: 78,
          weight: 63,
          height: 164,
          idempotencyKey: `vitals-${runSuffix}`
        }
      });
      assert.equal(vitals.status, 201, vitals.body.message);
      testContext.vitalId = vitals.body.data.id;
      assert.ok(await Vital.exists({ _id: testContext.vitalId, encounter: testContext.encounterId }));

      const notes = await request(baseUrl, `/api/encounters/${testContext.encounterId}/notes`, {
        token: tokens.doctor,
        method: 'PATCH',
        body: { clinicalNotes: 'Synthetic E2E notes.', assessment: 'Stable synthetic finding.' }
      });
      assert.equal(notes.status, 200, notes.body.message);
      assert.equal((await Encounter.findById(testContext.encounterId).lean()).clinicalNotes, 'Synthetic E2E notes.');

      const diagnosis = await request(baseUrl, `/api/encounters/${testContext.encounterId}/diagnoses`, {
        token: tokens.doctor,
        method: 'POST',
        body: { patient: testContext.patientId, code: 'J06.9', description: 'Acute upper respiratory infection, unspecified', isPrimary: true, idempotencyKey: `diagnosis-${runSuffix}` }
      });
      assert.equal(diagnosis.status, 201, diagnosis.body.message);
      testContext.diagnosisId = diagnosis.body.data.id;
      assert.ok(await Diagnosis.exists({ _id: testContext.diagnosisId, patient: testContext.patientId }));

      const forbidden = await request(baseUrl, `/api/encounters/${testContext.encounterId}/vitals`, {
        token: tokens.receptionist,
        method: 'POST',
        body: { patient: testContext.patientId }
      });
      assert.equal(forbidden.status, 403);
    });

    await t.test('allergy block and authorized override create audited prescriptions with Medication references', async () => {
      const medication = await Medication.create({
        name: `Penicillin Synthetic ${runSuffix}`, category: 'antibiotic', strength: '250 mg', dosageForm: 'capsule',
        route: 'oral', createdBy: users.admin._id, isActive: true
      });
      testContext.medicationId = medication._id.toString();
      await Allergy.create({ patient: testContext.patientId, allergen: 'penicillin', reaction: 'rash', severity: 'moderate', recordedBy: users.doctor._id });

      const prescriptionBody = {
        medicationId: testContext.medicationId,
        dose: '250 mg', route: 'oral', frequency: 'twice daily', duration: 5, quantity: 10,
        idempotencyKey: `rx-${runSuffix}`
      };
      const blocked = await request(baseUrl, `/api/encounters/${testContext.encounterId}/prescriptions`, {
        token: tokens.doctor, method: 'POST', body: prescriptionBody
      });
      assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
      assert.equal(blocked.body.data.allergyWarning, true);
      assert.equal(await Prescription.countDocuments({ medication: testContext.medicationId }), 0);

      const override = await request(baseUrl, `/api/encounters/${testContext.encounterId}/prescriptions`, {
        token: tokens.doctor,
        method: 'POST',
        body: {
          ...prescriptionBody,
          overrideAllergyWarning: true,
          allergyOverrideReason: 'Synthetic clinical override documented for end-to-end verification.'
        }
      });
      assert.equal(override.status, 201, override.body.message);
      testContext.prescriptionId = override.body.data.id;
      const saved = await Prescription.findById(testContext.prescriptionId).select('+allergyOverrideReason').lean();
      assert.ok(saved);
      assert.equal(String(saved.medication), testContext.medicationId);
      assert.ok(saved.allergyOverrideReason);
      assert.equal(await AuditLog.countDocuments({ action: 'prescription_allergy_override', entityId: saved._id }), 1);
      assert.equal(await AuditLog.countDocuments({ action: 'prescription_created', entityId: saved._id }), 1);
    });

    await t.test('lab technician completes an ordered component result through HTTP and MongoDB', async () => {
      const order = await request(baseUrl, `/api/encounters/${testContext.encounterId}/lab-orders`, {
        token: tokens.doctor,
        method: 'POST',
        body: {
          testName: 'Synthetic respiratory panel',
          components: [{ componentId: 'screen', name: 'Screen result' }],
          priority: 'routine', idempotencyKey: `lab-order-${runSuffix}`
        }
      });
      assert.equal(order.status, 201, order.body.message);
      testContext.labOrderId = order.body.data.id;
      assert.ok(await LabOrder.exists({ _id: testContext.labOrderId, status: 'pending' }));

      const queue = await request(baseUrl, '/api/lab/orders/pending', { token: tokens.lab_technician });
      assert.equal(queue.status, 200, queue.body.message);
      assert.ok(queue.body.data.orders.some((row) => row.id === testContext.labOrderId));

      const result = await request(baseUrl, `/api/lab/orders/${testContext.labOrderId}/results`, {
        token: tokens.lab_technician,
        method: 'POST',
        body: { componentId: 'screen', resultType: 'text', textValue: 'negative', idempotencyKey: `lab-result-${runSuffix}` }
      });
      assert.equal(result.status, 201, result.body.message);
      testContext.labResultId = result.body.data.result.id;
      assert.ok(await LabResult.exists({ _id: testContext.labResultId, labOrder: testContext.labOrderId, textValue: 'negative' }));
      assert.equal((await LabOrder.findById(testContext.labOrderId).lean()).status, 'completed');
      assert.equal(await AuditLog.countDocuments({ action: 'lab_result_recorded', entityId: testContext.labResultId }), 1);
    });

    await t.test('pharmacist dispenses through HTTP transaction and stock, prescription, dispense, and audit persist together', async () => {
      const inventory = await Inventory.create({
        medication: testContext.medicationId,
        batchNumber: `http-e2e-batch-${runSuffix}`,
        quantity: 12,
        minimumStock: 1,
        unit: 'capsules',
        expiryDate: new Date(Date.now() + 90 * 86400000),
        lastUpdatedBy: users.pharmacist._id
      });
      testContext.inventoryId = inventory._id.toString();
      const sourcePrescription = await Prescription.findById(testContext.prescriptionId).lean();
      const cancelledPrescription = await Prescription.create({
        patient: sourcePrescription.patient,
        encounter: sourcePrescription.encounter,
        doctor: sourcePrescription.doctor,
        medication: sourcePrescription.medication,
        drugName: sourcePrescription.drugName,
        dose: sourcePrescription.dose,
        route: sourcePrescription.route,
        frequency: sourcePrescription.frequency,
        duration: sourcePrescription.duration,
        quantity: sourcePrescription.quantity,
        status: 'cancelled'
      });

      const missingAuth = await request(baseUrl, '/api/pharmacy/prescriptions/pending');
      assert.equal(missingAuth.status, 401);
      const unsupportedFilter = await request(baseUrl, '/api/pharmacy/prescriptions/pending?status=all', { token: tokens.pharmacist });
      assert.equal(unsupportedFilter.status, 400);
      assert.equal((await request(baseUrl, '/api/pharmacy/prescriptions/pending?limit=101', { token: tokens.pharmacist })).status, 400);
      assert.equal((await request(baseUrl, '/api/pharmacy/prescriptions/pending?page=0', { token: tokens.pharmacist })).status, 400);
      for (const role of ['admin', 'receptionist', 'doctor', 'lab_technician', 'patient']) {
        const deniedQueue = await request(baseUrl, '/api/pharmacy/prescriptions/pending', { token: tokens[role] });
        assert.equal(deniedQueue.status, 403, `${role} must not read the pharmacy queue`);
        const deniedDetails = await request(baseUrl, `/api/pharmacy/prescriptions/${testContext.prescriptionId}`, { token: tokens[role] });
        assert.equal(deniedDetails.status, 403, `${role} must not read pharmacy prescription details`);
      }

      const initialQueue = await request(baseUrl, '/api/pharmacy/prescriptions/pending?page=1&limit=1', { token: tokens.pharmacist });
      assert.equal(initialQueue.status, 200, initialQueue.body.message);
      assert.equal(initialQueue.body.data.pagination.page, 1);
      assert.equal(initialQueue.body.data.pagination.limit, 1);
      assert.equal(initialQueue.body.data.pagination.total, 1);
      const queued = initialQueue.body.data.prescriptions[0];
      assert.equal(queued.id, testContext.prescriptionId);
      assert.equal(queued.patient.mrn, testContext.mrn);
      assert.equal(queued.encounter.id, testContext.encounterId);
      assert.equal(queued.doctor.id, users.doctor._id.toString());
      assert.equal(queued.medication.id, testContext.medicationId);
      assert.equal(queued.dose, '250 mg');
      assert.equal(queued.quantity, 10);
      assert.equal(queued.alreadyDispensed, 0);
      assert.equal(queued.remainingQuantity, 10);
      assert.equal(queued.status, 'pending');
      assert.equal(Object.hasOwn(queued, 'clinicalNotes'), false);
      assert.equal(Object.hasOwn(queued, 'allergyOverrideReason'), false);
      assert.equal(initialQueue.body.data.prescriptions.some((row) => row.id === cancelledPrescription._id.toString()), false);

      const initialDetail = await request(baseUrl, `/api/pharmacy/prescriptions/${testContext.prescriptionId}`, { token: tokens.pharmacist });
      assert.equal(initialDetail.status, 200, initialDetail.body.message);
      assert.equal(initialDetail.body.data.dispensingHistory.length, 0);
      assert.equal(initialDetail.body.data.remainingQuantity, 10);
      assert.equal(Object.hasOwn(initialDetail.body.data, 'instructions'), false);
      assert.equal(Object.hasOwn(initialDetail.body.data, 'clinicalNotes'), false);

      const response = await request(baseUrl, `/api/pharmacy/prescriptions/${testContext.prescriptionId}/dispense`, {
        token: tokens.pharmacist,
        method: 'POST',
        body: { inventoryId: testContext.inventoryId, quantity: 2, idempotencyKey: `http-dispense-${runSuffix}` }
      });
      assert.equal(response.status, 201, response.body.message);
      testContext.dispenseId = response.body.data.id;
      assert.equal((await Inventory.findById(testContext.inventoryId).lean()).quantity, 10);
      assert.equal((await Prescription.findById(testContext.prescriptionId).lean()).status, 'partially_dispensed');
      assert.ok(await Dispense.exists({ _id: testContext.dispenseId, quantityDispensed: 2 }));
      assert.equal(await AuditLog.countDocuments({ action: 'prescription_dispensed', entityId: testContext.dispenseId }), 1);

      const repeated = await request(baseUrl, `/api/pharmacy/prescriptions/${testContext.prescriptionId}/dispense`, {
        token: tokens.pharmacist,
        method: 'POST',
        body: { inventoryId: testContext.inventoryId, quantity: 2, idempotencyKey: `http-dispense-${runSuffix}` }
      });
      assert.equal(repeated.status, 200, repeated.body.message);
      assert.equal(repeated.body.data.id, testContext.dispenseId);
      assert.equal((await Inventory.findById(testContext.inventoryId).lean()).quantity, 10);
      assert.equal(await Dispense.countDocuments({ prescription: testContext.prescriptionId }), 1);

      const partialQueue = await request(baseUrl, '/api/pharmacy/prescriptions/pending', { token: tokens.pharmacist });
      const partialRow = partialQueue.body.data.prescriptions.find((row) => row.id === testContext.prescriptionId);
      assert.equal(partialRow.alreadyDispensed, 2);
      assert.equal(partialRow.remainingQuantity, 8);
      assert.equal(partialRow.status, 'partially_dispensed');
      const partialDetail = await request(baseUrl, `/api/pharmacy/prescriptions/${testContext.prescriptionId}`, { token: tokens.pharmacist });
      assert.equal(partialDetail.body.data.dispensingHistory.length, 1);
      assert.equal(partialDetail.body.data.remainingQuantity, 8);

      const overRemaining = await request(baseUrl, `/api/pharmacy/prescriptions/${testContext.prescriptionId}/dispense`, {
        token: tokens.pharmacist,
        method: 'POST',
        body: { inventoryId: testContext.inventoryId, quantity: 9, idempotencyKey: `http-over-remaining-${runSuffix}` }
      });
      assert.equal(overRemaining.status, 409);
      const lowStock = await Inventory.create({
        medication: testContext.medicationId,
        batchNumber: `http-e2e-low-stock-${runSuffix}`,
        quantity: 1,
        minimumStock: 1,
        unit: 'capsules',
        expiryDate: new Date(Date.now() + 90 * 86400000),
        lastUpdatedBy: users.pharmacist._id
      });
      const insufficient = await request(baseUrl, `/api/pharmacy/prescriptions/${testContext.prescriptionId}/dispense`, {
        token: tokens.pharmacist,
        method: 'POST',
        body: { inventoryId: lowStock._id.toString(), quantity: 2, idempotencyKey: `http-insufficient-${runSuffix}` }
      });
      assert.equal(insufficient.status, 409);
      assert.equal((await Inventory.findById(lowStock._id).lean()).quantity, 1);

      const completed = await request(baseUrl, `/api/pharmacy/prescriptions/${testContext.prescriptionId}/dispense`, {
        token: tokens.pharmacist,
        method: 'POST',
        body: { inventoryId: testContext.inventoryId, quantity: 8, idempotencyKey: `http-dispense-final-${runSuffix}` }
      });
      assert.equal(completed.status, 201, completed.body.message);
      assert.equal((await Prescription.findById(testContext.prescriptionId).lean()).status, 'dispensed');
      const finalDetail = await request(baseUrl, `/api/pharmacy/prescriptions/${testContext.prescriptionId}`, { token: tokens.pharmacist });
      assert.equal(finalDetail.body.data.status, 'dispensed');
      assert.equal(finalDetail.body.data.remainingQuantity, 0);
      assert.equal(finalDetail.body.data.alreadyDispensed, 10);
      assert.equal(finalDetail.body.data.dispensingHistory.length, 2);
      const completedReplay = await request(baseUrl, `/api/pharmacy/prescriptions/${testContext.prescriptionId}/dispense`, {
        token: tokens.pharmacist,
        method: 'POST',
        body: { inventoryId: testContext.inventoryId, quantity: 8, idempotencyKey: `http-dispense-final-${runSuffix}` }
      });
      assert.equal(completedReplay.status, 200);
      assert.equal(completedReplay.body.data.replayed, true);
      const extraAfterFull = await request(baseUrl, `/api/pharmacy/prescriptions/${testContext.prescriptionId}/dispense`, {
        token: tokens.pharmacist,
        method: 'POST',
        body: { inventoryId: testContext.inventoryId, quantity: 1, idempotencyKey: `http-after-full-${runSuffix}` }
      });
      assert.equal(extraAfterFull.status, 409);
      assert.equal((await Inventory.findById(testContext.inventoryId).lean()).quantity, 2);
      assert.equal(await Dispense.countDocuments({ prescription: testContext.prescriptionId }), 2);
      const finalQueue = await request(baseUrl, '/api/pharmacy/prescriptions/pending', { token: tokens.pharmacist });
      assert.equal(finalQueue.body.data.prescriptions.some((row) => row.id === testContext.prescriptionId), false);
      assert.equal(finalQueue.body.data.prescriptions.some((row) => row.id === cancelledPrescription._id.toString()), false);

      const forbidden = await request(baseUrl, `/api/pharmacy/inventory/${testContext.medicationId}`, { token: tokens.receptionist });
      assert.equal(forbidden.status, 403);
    });

    await t.test('patient portal reads are owner-scoped, omit internal data, audit access, and render a private PDF', async () => {
      const profile = await request(baseUrl, '/api/patient-portal/profile', { token: tokens.patient });
      assert.equal(profile.status, 200, profile.body.message);
      assert.equal(profile.body.data.mrn, testContext.mrn);
      assert.equal(profile.body.data.id, testContext.patientId);
      assert.equal(JSON.stringify(profile.body).includes('Synthetic E2E notes.'), false);
      assert.ok(await AccessLog.exists({ patient: testContext.patientId, user: users.patient._id, accessMethod: 'patient_portal' }));

      const visits = await request(baseUrl, '/api/encounters?page=1&limit=10', { token: tokens.patient });
      assert.equal(visits.status, 200, visits.body.message);
      assert.equal(visits.body.data.encounters[0].id, testContext.encounterId);
      assert.equal(JSON.stringify(visits.body).includes('clinicalNotes'), false);
      assert.equal(JSON.stringify(visits.body).includes('Synthetic E2E notes.'), false);

      const labs = await request(baseUrl, '/api/patient-portal/lab-results?page=1&limit=10', { token: tokens.patient });
      assert.equal(labs.status, 200, labs.body.message);
      assert.ok(labs.body.data.results.some((row) => row.id === testContext.labResultId && row.textValue === 'negative'));
      assert.equal(JSON.stringify(labs.body).includes('technician'), false);
      assert.equal(JSON.stringify(labs.body).includes('notes'), false);

      const prescriptions = await request(baseUrl, '/api/patient-portal/prescriptions?page=1&limit=10', { token: tokens.patient });
      assert.equal(prescriptions.status, 200, prescriptions.body.message);
      assert.ok(prescriptions.body.data.prescriptions.some((row) => row.id === testContext.prescriptionId));
      assert.equal(JSON.stringify(prescriptions.body).includes('allergyOverrideReason'), false);
      assert.equal(JSON.stringify(prescriptions.body).includes('instructions'), false);

      for (const role of ['admin', 'receptionist', 'doctor', 'lab_technician', 'pharmacist']) {
        assert.equal((await request(baseUrl, '/api/patient-portal/profile', { token: tokens[role] })).status, 403, `${role} cannot access patient portal profile`);
      }
      assert.equal((await request(baseUrl, `/api/patient-portal/profile?patientId=${testContext.otherPatientId}`, { token: tokens.patient })).status, 400);
      assert.equal((await request(baseUrl, `/api/patient-portal/lab-results?patientId=${testContext.otherPatientId}`, { token: tokens.patient })).status, 400);
      assert.equal((await request(baseUrl, `/api/encounters?patientId=${testContext.otherPatientId}`, { token: tokens.patient })).status, 400);
      assert.equal((await request(baseUrl, '/api/admin/access-logs', { token: tokens.patient })).status, 403);
      assert.equal((await request(baseUrl, '/api/admin/audit-logs', { token: tokens.patient })).status, 403);

      const pdfResponse = await fetch(`${baseUrl}/api/patient-portal/summary.pdf`, { headers: { Authorization: `Bearer ${tokens.patient}` } });
      assert.equal(pdfResponse.status, 200);
      assert.equal(pdfResponse.headers.get('content-type'), 'application/pdf');
      assert.equal(pdfResponse.headers.get('cache-control'), 'private, no-store');
      const pdf = Buffer.from(await pdfResponse.arrayBuffer()).toString('ascii');
      assert.ok(pdf.startsWith('%PDF-1.7'));
      assert.ok(pdf.includes('/ToUnicode'));
      assert.ok(pdf.includes('/FontFile2'));
      assert.ok(pdf.includes('NotoSans'));
      assert.equal(pdf.includes('Synthetic E2E notes.'), false);
      assert.equal(pdf.includes('Stable synthetic finding.'), false);
    });

    await t.test('patient portal ownership, consent grant/revocation, payment, and payment audit are enforced', async () => {
      const consent = await request(baseUrl, '/api/consents', {
        token: tokens.patient,
        method: 'POST',
        body: { doctorId: users.doctor._id.toString(), scope: 'clinical_record' }
      });
      assert.equal(consent.status, 201, consent.body.message);
      testContext.consentId = consent.body.data.id;
      assert.ok(await Consent.exists({ _id: testContext.consentId, status: 'granted' }));

      const secondPatientRegistration = await request(baseUrl, '/api/patients', {
        token: tokens.receptionist,
        method: 'POST',
        body: {
          firstName: `Hodan${runSuffix}`, fatherName: 'Synthetic', grandfatherName: 'Other', sex: 'female',
          phone: '252612345679',
          estimatedAge: 26, idempotencyKey: `other-patient-${runSuffix}`
        }
      });
      assert.equal(secondPatientRegistration.status, 201);
      testContext.otherPatientId = secondPatientRegistration.body.data.id;
      const otherPatient = await Patient.findById(testContext.otherPatientId).lean();
      const otherPortal = await createHttpUser('patient', passwordHash, otherPatient);
      const otherToken = await login(baseUrl, otherPortal, password);

      const ownerAccess = await request(baseUrl, `/api/patients/${testContext.patientId}/timeline`, { token: tokens.patient });
      assert.equal(ownerAccess.status, 200, ownerAccess.body.message);
      assert.equal(JSON.stringify(ownerAccess.body).includes('Synthetic E2E notes.'), false);
      assert.equal(JSON.stringify(ownerAccess.body).includes('Stable synthetic finding.'), false);
      const crossOwnerAccess = await request(baseUrl, `/api/patients/${testContext.otherPatientId}/timeline`, { token: tokens.patient });
      assert.ok([403, 404].includes(crossOwnerAccess.status));
      const crossOwnerIdentity = await request(baseUrl, `/api/patients/${testContext.patientId}`, { token: otherToken });
      assert.ok([403, 404].includes(crossOwnerIdentity.status));

      const revoke = await request(baseUrl, `/api/consents/${testContext.consentId}/revoke`, {
        token: tokens.patient, method: 'PATCH', body: {}
      });
      assert.equal(revoke.status, 200, revoke.body.message);
      assert.equal((await Consent.findById(testContext.consentId).lean()).status, 'revoked');
      assert.equal(await AuditLog.countDocuments({ action: 'patient_consent_granted', entityId: testContext.consentId }), 1);
      assert.equal(await AuditLog.countDocuments({ action: 'patient_consent_revoked', entityId: testContext.consentId }), 1);

      const payment = await request(baseUrl, '/api/payments', {
        token: tokens.patient,
        method: 'POST',
        body: { phoneNumber: '+252612345678', amount: 3.5, currency: 'USD', idempotencyKey: `http-payment-${runSuffix}` }
      });
      assert.equal(payment.status, 200, payment.body.message);
      assert.equal(payment.body.data.simulated, true);
      assert.equal(typeof payment.body.data.paymentReference, 'string');
      assert.ok(payment.body.data.paymentReference.length >= 8);
      testContext.paymentReference = payment.body.data.paymentReference;
      const savedPayment = await Payment.findOne({ initiatingUser: testContext.patientUser._id }).lean();
      assert.ok(savedPayment);
      assert.ok(await AuditLog.exists({ action: 'payment_initiated', entityType: 'Payment', entityId: savedPayment._id }));
      assert.ok(await AuditLog.exists({ action: 'payment_status_changed', entityType: 'Payment', entityId: savedPayment._id }));
    });

    await t.test('BreakGlass activation is audited, grants access, and expiration removes access', async () => {
      const activation = await request(baseUrl, `/api/patients/${testContext.otherPatientId}/break-glass`, {
        token: tokens.doctor,
        method: 'POST',
        body: { reason: 'Synthetic emergency access for HTTP E2E verification.' }
      });
      assert.equal(activation.status, 201, activation.body.message);
      testContext.breakGlassId = activation.body.data.id;
      assert.ok(await AuditLog.exists({ action: 'break_glass_activated', entityId: testContext.breakGlassId }));
      assert.ok(await Notification.exists({ recipient: users.admin._id, relatedId: testContext.breakGlassId }));
      const allowed = await request(baseUrl, `/api/patients/${testContext.otherPatientId}/timeline`, { token: tokens.doctor });
      assert.equal(allowed.status, 200, allowed.body.message);

      const authorization = await BreakGlass.findById(testContext.breakGlassId);
      await BreakGlass.collection.updateOne(
        { _id: authorization._id },
        { $set: { expiresAt: new Date(Date.now() - 1000) } }
      );
      await expireBreakGlassAuthorizations();
      assert.equal((await BreakGlass.findById(testContext.breakGlassId).lean()).status, 'expired');
      const denied = await request(baseUrl, `/api/patients/${testContext.otherPatientId}/timeline`, { token: tokens.doctor });
      assert.equal(denied.status, 403);
      assert.ok(await AccessLog.exists({ patient: testContext.otherPatientId, user: users.doctor._id, action: 'denied_access' }));
    });

    await t.test('referral notifications persist and inactive users lose protected access', async () => {
      const referral = await request(baseUrl, '/api/referrals', {
        token: tokens.doctor,
        method: 'POST',
        body: {
          encounterId: testContext.encounterId,
          receivingHospital: (await Department.findById(testContext.departmentId).lean()).name,
          receivingDoctorId: users.doctor._id.toString(),
          specialist: 'Respiratory medicine',
          reason: 'Synthetic referral for persistent respiratory symptoms.',
          clinicalSummary: 'Synthetic clinical summary for E2E test only.',
          idempotencyKey: `referral-${runSuffix}`
        }
      });
      assert.equal(referral.status, 201, referral.body.message);
      testContext.referralId = referral.body.data.id;
      assert.ok(await Referral.exists({ _id: testContext.referralId, encounter: testContext.encounterId }));
      assert.ok(await AuditLog.exists({ action: 'referral_created', entityId: testContext.referralId }));
      assert.ok(await Notification.exists({ relatedId: testContext.referralId }));

      const inactive = await createHttpUser('lab_technician', passwordHash);
      inactive.isActive = false;
      await inactive.save();
      const inactiveLogin = await request(baseUrl, '/api/auth/login', {
        method: 'POST', body: { username: inactive.username, password }
      });
      assert.equal(inactiveLogin.status, 401);
      const protectedCall = await request(baseUrl, '/api/lab/orders/pending', { token: tokens.lab_technician });
      assert.equal(protectedCall.status, 200);
      inactive.isActive = true;
      await inactive.save();
      const inactiveToken = await login(baseUrl, inactive, password);
      inactive.isActive = false;
      await inactive.save();
      const revokedToken = await request(baseUrl, '/api/lab/orders/pending', { token: inactiveToken });
      assert.equal(revokedToken.status, 401);
    });
  } finally {
    if (httpServer) {
      httpServer.closeAllConnections();
      await new Promise((resolve) => httpServer.close(resolve));
    }
    if (dbConnected && mongoose.connection.readyState === 1) {
      // This generated database belongs exclusively to this test invocation.
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  }
});

