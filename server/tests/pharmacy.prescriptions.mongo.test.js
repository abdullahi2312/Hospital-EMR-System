'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const mongoose = require('mongoose');

const integrationUri = process.env.MONGO_INTEGRATION_URI;
const shouldRun = typeof integrationUri === 'string' && integrationUri.length > 0;
const runSuffix = `${process.pid}_${crypto.randomBytes(5).toString('hex')}`;
process.env.PATIENT_IDENTITY_HMAC_SECRET = 'pharmacy-mongo-test-identity-secret-32-bytes-minimum';
process.env.JWT_SECRET = 'pharmacy-mongo-test-jwt-secret-with-enough-entropy-12345';
process.env.JWT_EXPIRES_IN = '1h';

const User = require('../models/User');
const Patient = require('../models/Patient');
const Encounter = require('../models/Encounter');
const Medication = require('../models/Medication');
const Prescription = require('../models/Prescription');
const Dispense = require('../models/Dispense');
const { listPendingPrescriptions, getPharmacistPrescriptionDetails } = require('../services/pharmacy.service');
const { generateToken } = require('../utils/token');
const app = require('../app');

function dedicatedDatabase(uri) {
  let parsed;
  try { parsed = new URL(uri); } catch (_) { throw new Error('MONGO_INTEGRATION_URI must be a valid MongoDB URI'); }
  if (parsed.protocol !== 'mongodb:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
    throw new Error('Pharmacy MongoDB tests require a local MongoDB URI');
  }
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, '').split('/')[0] || '');
  if (!/test|integration/i.test(name) || /prod|production/i.test(name)) {
    throw new Error('MONGO_INTEGRATION_URI database name must identify an isolated test database');
  }
  return `${name}_pharmacy_queries_${runSuffix}`;
}

async function createUser(role, patientId) {
  const suffix = crypto.randomBytes(4).toString('hex');
  return User.create({
    fullName: `Pharmacy ${role}`, username: `pharm_${role}_${suffix}`, password: 'test-hash-placeholder', role, isActive: true,
    ...(role === 'patient' ? { patient: patientId } : {})
  });
}

async function httpRequest(baseUrl, pathname, user) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    headers: user ? { Authorization: `Bearer ${generateToken({ id: user._id.toString(), role: 'admin' })}` } : {}
  });
  return { status: response.status, body: await response.json() };
}

test('pharmacist queue and details use real MongoDB projections and remaining-quantity filtering', { skip: !shouldRun }, async (t) => {
  const databaseName = dedicatedDatabase(integrationUri);
  let connected = false;
  let httpServer;
  try {
    await mongoose.connect(integrationUri, { dbName: databaseName, serverSelectionTimeoutMS: 4000, maxPoolSize: 8 });
    connected = true;
    const pharmacist = await createUser('pharmacist');
    const doctor = await createUser('doctor');
    const registrar = await createUser('receptionist');
    const patient = await Patient.create({
      mrn: 'MRN-777777', firstName: 'Tijaabo', fatherName: 'Farmashiye', grandfatherName: 'Bukaan',
      sex: 'female', estimatedAge: 32, registeredBy: registrar._id
    });
    const encounter = await Encounter.create({
      patient: patient._id, visitNumber: `PHARM-${runSuffix}`, department: 'OPD', assignedDoctor: doctor._id,
      status: 'in_progress', visitType: 'outpatient', clinicalNotes: 'Private unrelated clinical notes.'
    });
    const medication = await Medication.create({
      name: `pharmacy-test-${runSuffix}`, category: 'test', strength: '10 mg', dosageForm: 'tablet', route: 'oral', createdBy: doctor._id
    });

    async function prescription(status, quantity, key) {
      return Prescription.create({
        patient: patient._id, encounter: encounter._id, doctor: doctor._id, medication: medication._id,
        drugName: medication.name, dose: '10 mg', route: 'oral', frequency: 'daily', duration: 5, quantity, status,
        instructions: `Do not expose ${key}`
      });
    }

    const pending = await prescription('pending', 10, 'pending');
    const partial = await prescription('partially_dispensed', 10, 'partial');
    const complete = await prescription('dispensed', 10, 'complete');
    const cancelled = await prescription('cancelled', 10, 'cancelled');
    const exhaustedPending = await prescription('pending', 3, 'exhausted');
    const inactiveMedication = await Medication.create({
      name: `inactive-pharmacy-test-${runSuffix}`, category: 'test', strength: '5 mg', dosageForm: 'tablet', route: 'oral', createdBy: doctor._id, isActive: false
    });
    const inactiveMedicationPrescription = await Prescription.create({
      patient: patient._id, encounter: encounter._id, doctor: doctor._id, medication: inactiveMedication._id,
      drugName: inactiveMedication.name, dose: '5 mg', route: 'oral', frequency: 'daily', duration: 3, quantity: 3, status: 'pending'
    });
    const otherPatient = await Patient.create({
      mrn: 'MRN-777778', firstName: 'Kale', fatherName: 'Qalad', grandfatherName: 'Xiriir',
      sex: 'male', estimatedAge: 44, registeredBy: registrar._id
    });
    const unrelatedEncounter = await Encounter.create({
      patient: otherPatient._id, visitNumber: `PHARM-OTHER-${runSuffix}`, department: 'OPD', assignedDoctor: doctor._id,
      status: 'in_progress', visitType: 'outpatient'
    });
    const mismatchedPrescription = await Prescription.create({
      patient: patient._id, encounter: unrelatedEncounter._id, doctor: doctor._id, medication: medication._id,
      drugName: medication.name, dose: '10 mg', route: 'oral', frequency: 'daily', duration: 2, quantity: 2, status: 'pending'
    });

    async function recordDispense(rx, quantity, key) {
      return Dispense.create({
        prescription: rx._id, patient: patient._id, medication: medication._id,
        inventory: new mongoose.Types.ObjectId(), pharmacist: pharmacist._id,
        quantityDispensed: quantity, unit: 'tablets', dispensedAt: new Date(Date.now() + Number(key))
      });
    }
    await recordDispense(partial, 3, 1);
    await recordDispense(complete, 10, 2);
    await recordDispense(exhaustedPending, 3, 3);

    httpServer = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
      httpServer.once('listening', resolve);
      httpServer.once('error', reject);
    });
    const address = httpServer.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    await t.test('queue returns only pending and partially dispensed prescriptions with server-derived totals', async () => {
      const firstPage = await listPendingPrescriptions({ page: 1, limit: 1 }, { id: pharmacist._id.toString() });
      assert.equal(firstPage.pagination.total, 2);
      assert.equal(firstPage.pagination.totalPages, 2);
      assert.equal(firstPage.prescriptions.length, 1);
      assert.equal(firstPage.prescriptions[0].id, partial._id.toString());
      assert.equal(firstPage.prescriptions[0].alreadyDispensed, 3);
      assert.equal(firstPage.prescriptions[0].remainingQuantity, 7);
      assert.equal(firstPage.prescriptions[0].status, 'partially_dispensed');
      assert.equal(Object.hasOwn(firstPage.prescriptions[0], 'instructions'), false);
      assert.equal(Object.hasOwn(firstPage.prescriptions[0], 'clinicalNotes'), false);

      const secondPage = await listPendingPrescriptions({ page: 2, limit: 1 }, { id: pharmacist._id.toString() });
      assert.equal(secondPage.prescriptions[0].id, pending._id.toString());
      assert.equal(secondPage.prescriptions[0].alreadyDispensed, 0);
      assert.equal(secondPage.prescriptions[0].remainingQuantity, 10);
      const allRows = [...firstPage.prescriptions, ...secondPage.prescriptions];
      assert.ok(![complete, cancelled, exhaustedPending, inactiveMedicationPrescription, mismatchedPrescription]
        .some((rx) => allRows.some((row) => row.id === rx._id.toString())));
    });

    await t.test('detail returns only permitted patient identity, prescription data, and dispense history', async () => {
      const detail = await getPharmacistPrescriptionDetails(partial._id.toString(), { id: pharmacist._id.toString() });
      assert.equal(detail.patient.mrn, patient.mrn);
      assert.equal(detail.encounter.visitNumber, encounter.visitNumber);
      assert.equal(detail.doctor.fullName, doctor.fullName);
      assert.equal(detail.medication.name, medication.name);
      assert.equal(detail.alreadyDispensed, 3);
      assert.equal(detail.remainingQuantity, 7);
      assert.equal(detail.dispensingHistory.length, 1);
      assert.equal(detail.dispensingHistory[0].quantityDispensed, 3);
      assert.equal(detail.status, 'partially_dispensed');
      assert.equal(Object.hasOwn(detail, 'instructions'), false);
      assert.equal(Object.hasOwn(detail, 'clinicalNotes'), false);
      assert.equal(Object.hasOwn(detail, 'allergyOverrideReason'), false);
      assert.equal(detail.canDispense, true);

      const inactiveDetail = await getPharmacistPrescriptionDetails(inactiveMedicationPrescription._id.toString(), { id: pharmacist._id.toString() });
      assert.equal(inactiveDetail.medication.active, false);
      assert.equal(inactiveDetail.canDispense, false);
      const mismatchedDetail = await getPharmacistPrescriptionDetails(mismatchedPrescription._id.toString(), { id: pharmacist._id.toString() });
      assert.equal(mismatchedDetail.canDispense, false);
    });

    await t.test('real HTTP queue and detail routes read the isolated MongoDB records and enforce role authorization', async () => {
      const unauthenticated = await httpRequest(baseUrl, '/api/pharmacy/prescriptions/pending');
      assert.equal(unauthenticated.status, 401);
      const queue = await httpRequest(baseUrl, '/api/pharmacy/prescriptions/pending?page=1&limit=5', pharmacist);
      assert.equal(queue.status, 200, queue.body.message);
      assert.equal(queue.body.data.pagination.total, 2);
      const queueRow = queue.body.data.prescriptions.find((row) => row.id === partial._id.toString());
      assert.equal(queueRow.remainingQuantity, 7);
      assert.equal(Object.hasOwn(queueRow, 'instructions'), false);

      const detail = await httpRequest(baseUrl, `/api/pharmacy/prescriptions/${partial._id}`, pharmacist);
      assert.equal(detail.status, 200, detail.body.message);
      assert.equal(detail.body.data.dispensingHistory.length, 1);
      assert.equal(detail.body.data.remainingQuantity, 7);
      assert.equal(Object.hasOwn(detail.body.data, 'clinicalNotes'), false);

      const forbidden = await httpRequest(baseUrl, `/api/pharmacy/prescriptions/${partial._id}`, doctor);
      assert.equal(forbidden.status, 403);
    });

    await t.test('inactive pharmacist and other roles are denied by the service authorization guard', async () => {
      for (const role of ['admin', 'receptionist', 'doctor', 'lab_technician', 'patient']) {
        const user = await createUser(role, patient._id);
        await assert.rejects(listPendingPrescriptions({}, { id: user._id.toString() }), (error) => error.status === 403);
        await assert.rejects(getPharmacistPrescriptionDetails(pending._id.toString(), { id: user._id.toString() }), (error) => error.status === 403);
      }
      const inactive = await createUser('pharmacist');
      inactive.isActive = false;
      await inactive.save();
      await assert.rejects(listPendingPrescriptions({}, { id: inactive._id.toString() }), (error) => error.status === 401);
    });
  } finally {
    if (httpServer) {
      httpServer.closeAllConnections();
      await new Promise((resolve) => httpServer.close(resolve));
    }
    if (connected && mongoose.connection.readyState === 1) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  }
});
