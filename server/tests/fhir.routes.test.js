'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');

process.env.JWT_SECRET = 'fhir-route-test-secret-with-sufficient-entropy-123';
process.env.JWT_EXPIRES_IN = '1d';

const User = require('../models/User');
const Patient = require('../models/Patient');
const Encounter = require('../models/Encounter');
const Vital = require('../models/Vital');
const LabOrder = require('../models/LabOrder');
const LabResult = require('../models/LabResult');
const Prescription = require('../models/Prescription');
const AccessLog = require('../models/AccessLog');
const Consent = require('../models/Consent');
const BreakGlass = require('../models/BreakGlass');
const { generateToken } = require('../utils/token');

const ids = {
  patientUser: new mongoose.Types.ObjectId(),
  doctor: new mongoose.Types.ObjectId(),
  otherDoctor: new mongoose.Types.ObjectId(),
  receptionist: new mongoose.Types.ObjectId(),
  labTechnician: new mongoose.Types.ObjectId(),
  pharmacist: new mongoose.Types.ObjectId(),
  admin: new mongoose.Types.ObjectId(),
  patient: new mongoose.Types.ObjectId(),
  otherPatient: new mongoose.Types.ObjectId(),
  encounter: new mongoose.Types.ObjectId(),
  vital: new mongoose.Types.ObjectId(),
  labOrder: new mongoose.Types.ObjectId(),
  labResult: new mongoose.Types.ObjectId(),
  prescription: new mongoose.Types.ObjectId(),
  consent: new mongoose.Types.ObjectId(),
  breakGlass: new mongoose.Types.ObjectId()
};

const accounts = new Map();
const patients = new Map();
const encounters = new Map();
const vitals = new Map();
const labOrders = new Map();
const labResults = new Map();
const prescriptions = new Map();
let accessRecords = [];
let failAccessLog = false;
let consentEnabled = false;
let breakGlassEnabled = false;
let breakGlassExpired = false;

function query(value) {
  return {
    select() { return this; },
    sort() { return this; },
    limit() { return this; },
    async lean() { return value; }
  };
}

User.findById = (id) => query(accounts.get(String(id)) || null);
Patient.findById = (id) => query(patients.get(String(id)) || null);
Patient.exists = async ({ _id }) => patients.has(String(_id)) ? { _id } : null;
Encounter.findById = (id) => query(encounters.get(String(id)) || null);
Encounter.findOne = (filter) => {
  let match = null;
  for (const record of encounters.values()) {
    if (String(record.patient) !== String(filter.patient)) continue;
    if (filter.assignedDoctor && String(record.assignedDoctor) !== String(filter.assignedDoctor)) continue;
    match = record;
    break;
  }
  return query(match ? { _id: match._id } : null);
};
Vital.findById = (id) => query(vitals.get(String(id)) || null);
LabOrder.findById = (id) => query(labOrders.get(String(id)) || null);
LabResult.findById = (id) => query(labResults.get(String(id)) || null);
Prescription.findById = (id) => query(prescriptions.get(String(id)) || null);
Consent.findOne = (filter) => query(
  consentEnabled && String(filter.patient) === String(ids.patient) && String(filter.doctor) === String(ids.otherDoctor)
    ? { _id: ids.consent }
    : null
);
BreakGlass.find = (filter) => query(
  breakGlassEnabled && !breakGlassExpired && String(filter.patient) === String(ids.patient) && String(filter.doctor) === String(ids.otherDoctor)
    ? [{ _id: ids.breakGlass }]
    : []
);
BreakGlass.findOne = (filter) => query(
  breakGlassEnabled && String(filter._id) === String(ids.breakGlass) && filter.expiresAt?.$gt > new Date(0)
    ? { _id: ids.breakGlass, patient: ids.patient, doctor: ids.otherDoctor, status: 'active', reason: 'Emergency access reason long enough', expiresAt: new Date(Date.now() + 60_000), reviewedBy: null, reviewedAt: null }
    : null
);
AccessLog.create = async (record) => {
  if (failAccessLog) throw new Error('mock access log failure');
  accessRecords.push(record);
  return record;
};

function resetMocks() {
  const now = new Date('2026-11-05T10:15:00.000Z');
  accounts.clear();
  patients.clear();
  encounters.clear();
  vitals.clear();
  labOrders.clear();
  labResults.clear();
  prescriptions.clear();
  accessRecords = [];
  failAccessLog = false;
  consentEnabled = false;
  breakGlassEnabled = false;
  breakGlassExpired = false;

  accounts.set(String(ids.patientUser), { _id: ids.patientUser, role: 'patient', patient: ids.patient, isActive: true });
  accounts.set(String(ids.doctor), { _id: ids.doctor, role: 'doctor', isActive: true });
  accounts.set(String(ids.otherDoctor), { _id: ids.otherDoctor, role: 'doctor', isActive: true });
  accounts.set(String(ids.receptionist), { _id: ids.receptionist, role: 'receptionist', isActive: true });
  accounts.set(String(ids.labTechnician), { _id: ids.labTechnician, role: 'lab_technician', isActive: true });
  accounts.set(String(ids.pharmacist), { _id: ids.pharmacist, role: 'pharmacist', isActive: true });
  accounts.set(String(ids.admin), { _id: ids.admin, role: 'admin', isActive: true });
  patients.set(String(ids.patient), {
    _id: ids.patient, mrn: 'MRN-000123', firstName: 'Ayaan', fatherName: 'Ali', grandfatherName: 'Hassan',
    sex: 'female', dateOfBirth: new Date('1995-04-12T00:00:00.000Z'), phone: '+252611111111', district: 'Hodan',
    emergencyContact: 'private contact', allergies: ['private allergy'], registeredBy: ids.receptionist, updatedAt: now
  });
  patients.set(String(ids.otherPatient), { _id: ids.otherPatient, mrn: 'MRN-000124', firstName: 'Other', fatherName: 'Person', grandfatherName: 'Hidden', sex: 'male' });
  encounters.set(String(ids.encounter), {
    _id: ids.encounter, patient: ids.patient, visitNumber: 'VISIT-0001', department: 'OPD',
    assignedDoctor: ids.doctor, status: 'in_progress', visitType: 'outpatient', chiefComplaint: 'Headache',
    openedAt: now, clinicalNotes: 'private note', assessment: 'private assessment', updatedAt: now
  });
  vitals.set(String(ids.vital), {
    _id: ids.vital, patient: ids.patient, encounter: ids.encounter, recordedBy: ids.doctor,
    bloodPressure: { systolic: 120, diastolic: 80 }, temperature: 37, pulse: 72, weight: 65,
    height: 168, oxygenSaturation: 98, recordedAt: now, internalField: 'private'
  });
  labOrders.set(String(ids.labOrder), { _id: ids.labOrder, patient: ids.patient, encounter: ids.encounter, testName: 'Complete Blood Count', status: 'completed' });
  labResults.set(String(ids.labResult), {
    _id: ids.labResult, patient: ids.patient, labOrder: ids.labOrder, technician: ids.receptionist,
    resultType: 'numeric', numericValue: 4.5, unit: 'mg/dL', referenceRange: { minimum: 1, maximum: 5 },
    flag: 'normal', resultedAt: now, notes: 'internal note'
  });
  prescriptions.set(String(ids.prescription), {
    _id: ids.prescription, patient: ids.patient, encounter: ids.encounter, doctor: ids.doctor,
    drugName: 'Example medicine', dose: '250 mg', route: 'oral', frequency: 'Twice daily',
    duration: 5, quantity: 10, instructions: 'After meals', status: 'pending', prescribedAt: now, cancellationReason: 'private'
  });
}

const app = require('../app');
const server = http.createServer(app);

function makeToken(userId) { return generateToken({ id: String(userId), role: 'untrusted-role' }); }

function request(port, method, path, token) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method, path,
      headers: token ? { authorization: `Bearer ${token}` } : {}
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: raw ? JSON.parse(raw) : null }));
    });
    req.on('error', reject);
    req.end();
  });
}

test.before(async () => {
  resetMocks();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
});
test.after(async () => { await new Promise((resolve) => server.close(resolve)); });
test.beforeEach(resetMocks);

test('Patient, Encounter, Observation, and MedicationRequest map to FHIR-style resources', async () => {
  const port = server.address().port;
  const patientToken = makeToken(ids.patientUser);
  let result = await request(port, 'GET', `/api/fhir/Patient/${ids.patient}`, patientToken);
  assert.equal(result.status, 200);
  assert.match(result.type, /application\/fhir\+json/);
  assert.equal(result.body.resourceType, 'Patient');
  assert.equal(result.body.id, String(ids.patient));
  assert.equal(result.body.identifier[0].value, 'MRN-000123');
  assert.deepEqual(result.body.name[0].given, ['Ayaan', 'Ali', 'Hassan']);
  assert.equal(result.body.birthDate, '1995-04-12');
  assert.equal(JSON.stringify(result.body).includes('private allergy'), false);
  assert.equal(JSON.stringify(result.body).includes('private contact'), false);

  result = await request(port, 'GET', `/api/fhir/Encounter/${ids.encounter}`, makeToken(ids.doctor));
  assert.equal(result.status, 200);
  assert.equal(result.body.resourceType, 'Encounter');
  assert.deepEqual(result.body.subject, { reference: `Patient/${ids.patient}` });
  assert.equal(result.body.status, 'in-progress');
  assert.equal(result.body.class.code, 'AMB');
  assert.match(result.body.text.div, /private note/);
  assert.match(result.body.text.div, /private assessment/);

  result = await request(port, 'GET', `/api/fhir/Observation/${ids.vital}`, patientToken);
  assert.equal(result.status, 200);
  assert.equal(result.body.resourceType, 'Observation');
  assert.equal(result.body.component.length, 7);
  assert.deepEqual(result.body.encounter, { reference: `Encounter/${ids.encounter}` });
  assert.equal(JSON.stringify(result.body).includes('recordedBy'), false);

  result = await request(port, 'GET', `/api/fhir/Observation/${ids.labResult}`, patientToken);
  assert.equal(result.status, 200);
  assert.equal(result.body.valueQuantity.value, 4.5);
  assert.equal(result.body.referenceRange[0].low.value, 1);
  assert.equal(result.body.status, 'final');

  result = await request(port, 'GET', `/api/fhir/MedicationRequest/${ids.prescription}`, patientToken);
  assert.equal(result.status, 200);
  assert.equal(result.body.resourceType, 'MedicationRequest');
  assert.deepEqual(result.body.subject, { reference: `Patient/${ids.patient}` });
  assert.equal(result.body.medicationCodeableConcept.text, 'Example medicine');
  assert.equal(JSON.stringify(result.body).includes('private'), false);
});

test('patient can access only linked Patient and Encounter resources; cross-patient resource is concealed', async () => {
  const port = server.address().port;
  let result = await request(port, 'GET', `/api/fhir/Patient/${ids.otherPatient}`, makeToken(ids.patientUser));
  assert.equal(result.status, 404);
  assert.equal(result.body.resourceType, 'OperationOutcome');
  assert.ok(accessRecords.some((record) => record.action === 'denied_access'));

  result = await request(port, 'GET', `/api/fhir/Encounter/${ids.encounter}`, makeToken(ids.patientUser));
  assert.equal(result.status, 200);
  assert.ok(accessRecords.some((record) => record.accessMethod === 'patient_portal'));
});

test('doctor assigned encounter, consent, and break-glass use the existing access policy and audit methods', async () => {
  const port = server.address().port;
  let result = await request(port, 'GET', `/api/fhir/Observation/${ids.vital}`, makeToken(ids.doctor));
  assert.equal(result.status, 200);
  assert.ok(accessRecords.some((record) => record.accessMethod === 'assigned_visit' && String(record.encounter) === String(ids.encounter)));

  consentEnabled = true;
  result = await request(port, 'GET', `/api/fhir/Patient/${ids.patient}`, makeToken(ids.otherDoctor));
  assert.equal(result.status, 200);
  assert.ok(accessRecords.some((record) => record.accessMethod === 'patient_consent' && String(record.consent) === String(ids.consent)));

  consentEnabled = false;
  breakGlassEnabled = true;
  result = await request(port, 'GET', `/api/fhir/Encounter/${ids.encounter}`, makeToken(ids.otherDoctor));
  assert.equal(result.status, 200);
  assert.ok(accessRecords.some((record) => record.accessMethod === 'break_glass' && String(record.breakGlass) === String(ids.breakGlass)));

  breakGlassExpired = true;
  accessRecords = [];
  result = await request(port, 'GET', `/api/fhir/Encounter/${ids.encounter}`, makeToken(ids.otherDoctor));
  assert.equal(result.status, 404);
  assert.ok(accessRecords.some((record) => record.action === 'denied_access'));
});

test('receptionist access is denied and unknown patient/role paths do not expose resource existence', async () => {
  const port = server.address().port;
  const result = await request(port, 'GET', `/api/fhir/MedicationRequest/${ids.prescription}`, makeToken(ids.receptionist));
  assert.equal(result.status, 404);
  assert.equal(result.body.resourceType, 'OperationOutcome');
  assert.ok(accessRecords.some((record) => record.accessMethod === 'denied' && record.action === 'denied_access'));

  for (const roleId of [ids.labTechnician, ids.pharmacist, ids.admin]) {
    const denied = await request(port, 'GET', `/api/fhir/Encounter/${ids.encounter}`, makeToken(roleId));
    assert.equal(denied.status, 404);
  }
});

test('missing/malformed IDs and missing tokens receive safe FHIR OperationOutcome responses', async () => {
  const port = server.address().port;
  let result = await request(port, 'GET', '/api/fhir/Patient/not-an-id', makeToken(ids.patientUser));
  assert.equal(result.status, 400);
  assert.equal(result.body.resourceType, 'OperationOutcome');
  result = await request(port, 'GET', `/api/fhir/Patient/${ids.patient}`);
  assert.equal(result.status, 401);
  assert.equal(result.body.resourceType, 'OperationOutcome');
  result = await request(port, 'GET', `/api/fhir/Patient/${new mongoose.Types.ObjectId()}`, makeToken(ids.patientUser));
  assert.equal(result.status, 404);
});

test('read-only FHIR routes reject query and body inputs', async () => {
  const port = server.address().port;
  let result = await request(port, 'GET', `/api/fhir/Patient/${ids.patient}?_include=*`, makeToken(ids.patientUser));
  assert.equal(result.status, 400);
  assert.equal(result.body.resourceType, 'OperationOutcome');
});

test('access log failure fails closed and no FHIR resource is returned', async () => {
  const port = server.address().port;
  failAccessLog = true;
  const result = await request(port, 'GET', `/api/fhir/Patient/${ids.patient}`, makeToken(ids.patientUser));
  assert.equal(result.status, 503);
  assert.equal(result.body.resourceType, 'OperationOutcome');
  assert.equal(JSON.stringify(result.body).includes('mock access log failure'), false);
});

test('FHIR router is mounted once and exposes only read-only resource routes', () => {
  const fhirRouter = require('../routes/fhir.routes');
  const routeLayers = fhirRouter.stack.filter((layer) => layer.route);
  assert.deepEqual(routeLayers.map((layer) => [layer.route.path, Object.keys(layer.route.methods)[0]]), [
    ['/Patient/:id', 'get'], ['/Encounter/:id', 'get'], ['/Observation/:id', 'get'], ['/MedicationRequest/:id', 'get']
  ]);
  for (const layer of routeLayers) {
    assert.deepEqual(layer.route.stack.slice(0, 2).map((handler) => handler.name), ['authenticateFhir', 'readResource']);
  }
  assert.equal(app.router.stack.filter((layer) => layer.name === 'router' && layer.handle === fhirRouter).length, 1);
});
