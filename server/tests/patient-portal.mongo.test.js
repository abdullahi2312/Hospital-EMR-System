'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const integrationUri = process.env.MONGO_INTEGRATION_URI;
const shouldRun = typeof integrationUri === 'string' && integrationUri.length > 0;
const runSuffix = `${process.pid}_${crypto.randomBytes(5).toString('hex')}`;
process.env.PATIENT_IDENTITY_HMAC_SECRET = 'portal-http-test-patient-identity-secret-32-bytes-minimum';
process.env.JWT_SECRET = crypto.randomBytes(48).toString('base64url');
process.env.JWT_EXPIRES_IN = '1h';

const { MODEL_FILES } = require('../config/ensure-indexes');
const app = require('../app');
const { hashPassword } = require('../utils/password');
const User = require('../models/User');
const Patient = require('../models/Patient');
const Encounter = require('../models/Encounter');
const LabOrder = require('../models/LabOrder');
const LabResult = require('../models/LabResult');
const Prescription = require('../models/Prescription');
const AccessLog = require('../models/AccessLog');
const Consent = require('../models/Consent');
const AuditLog = require('../models/AuditLog');

function isolatedBaseName(uri) {
  let parsed;
  try { parsed = new URL(uri); } catch (_) { throw new Error('MONGO_INTEGRATION_URI must be a valid MongoDB URI'); }
  if (parsed.protocol !== 'mongodb:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
    throw new Error('Patient portal MongoDB tests require a local MongoDB URI');
  }
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, '').split('/')[0] || '');
  if (!/test|integration/i.test(name) || /prod|production/i.test(name)) throw new Error('MONGO_INTEGRATION_URI must name a dedicated test or integration database');
  return name;
}

async function call(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers: { ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}), ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {})
  });
  if (options.raw) return { status: response.status, headers: response.headers, bytes: Buffer.from(await response.arrayBuffer()) };
  return { status: response.status, headers: response.headers, body: await response.json() };
}

test('patient portal HTTP ownership and privacy against an isolated local MongoDB database', { skip: !shouldRun }, async (t) => {
  isolatedBaseName(integrationUri);
  const databaseName = `patient_portal_test_${runSuffix}`;
  let server;
  let connected = false;
  try {
    await mongoose.connect(integrationUri, { dbName: databaseName, serverSelectionTimeoutMS: 5000, maxPoolSize: 8 });
    connected = true;
    for (const modelName of MODEL_FILES) {
      const model = require(`../models/${modelName}`);
      try { await model.createIndexes(); }
      catch (error) { console.error(`MongoDB index creation failed for ${model.modelName}:`, error?.message || 'unknown index error'); throw error; }
    }
    const password = 'Synthetic-Portal-Only-Password-2026';
    const passwordHash = await hashPassword(password);
    const reception = await User.create({ fullName: 'Synthetic Reception', username: `pr_${runSuffix}`, password: passwordHash, role: 'receptionist', isActive: true });
    const doctor = await User.create({ fullName: 'Synthetic Doctor', username: `pd_${runSuffix}`, password: passwordHash, role: 'doctor', isActive: true });
    const otherDoctor = await User.create({ fullName: 'Synthetic Other Doctor', username: `po_${runSuffix}`, password: passwordHash, role: 'doctor', isActive: true });
    await User.create({ fullName: 'Synthetic Inactive Doctor', username: `pi_${runSuffix}`, password: passwordHash, role: 'doctor', isActive: false });
    const patients = [];
    for (const [index, name] of ['Ayaan Portal', 'Hodan Portal'].entries()) {
      patients.push(await Patient.create({
        mrn: `MRN-${String(700000 + (parseInt(runSuffix.slice(-4), 16) + index) % 99999).padStart(6, '0')}`,
        firstName: name.split(' ')[0], fatherName: index === 0 ? 'Axmed' : 'Synthetic', grandfatherName: index === 0 ? 'Čolić' : `Portal${index}`,
        sex: 'female', estimatedAge: 30 + index, phone: `2526123456${index}`,
        registeredBy: reception._id
      }));
    }
    const patientUsers = [];
    for (const [index, patient] of patients.entries()) {
      patientUsers.push(await User.create({ fullName: `Synthetic Patient ${index}`, username: `pp_${runSuffix}_${index}`, password: passwordHash, role: 'patient', isActive: true, patient: patient._id }));
    }
    const encounters = [];
    for (const [index, patient] of patients.entries()) {
      encounters.push(await Encounter.create({ patient: patient._id, visitNumber: `PORTAL-${runSuffix.slice(-5)}-${index}`, department: 'General', assignedDoctor: doctor._id, status: 'closed', visitType: 'outpatient', clinicalNotes: 'PRIVATE DOCTOR NOTE MUST NEVER APPEAR', assessment: 'PRIVATE ASSESSMENT MUST NEVER APPEAR' }));
    }
    const orders = [];
    for (const [index, patient] of patients.entries()) {
      orders.push(await LabOrder.create({ patient: patient._id, encounter: encounters[index]._id, doctor: doctor._id, testName: `Synthetic test ${index}`, status: 'completed', completedAt: new Date() }));
      await LabResult.create({ labOrder: orders[index]._id, patient: patient._id, technician: doctor._id, resultType: 'text', textValue: `synthetic-result-${index}`, notes: 'PRIVATE LAB STAFF NOTE MUST NEVER APPEAR' });
      await Prescription.create({ patient: patient._id, encounter: encounters[index]._id, doctor: doctor._id, drugName: `Synthetic medication ${index}`, dose: '10 mg', route: 'oral', frequency: 'once daily', duration: 3, quantity: 3, instructions: 'PRIVATE CLINICIAN INSTRUCTION MUST NEVER APPEAR', status: 'dispensed' });
    }

    server = app.listen(0);
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const firstLogin = await call(baseUrl, '/api/auth/patient-login', { method: 'POST', body: { mrn: patients[0].mrn.toLowerCase(), phone: '+252 (61) 234-560', password } });
    assert.equal(firstLogin.status, 200, firstLogin.body.message);
    const firstToken = firstLogin.body.data.token;
    assert.equal(firstLogin.body.data.user.patient, patients[0]._id.toString());
    assert.equal(Object.hasOwn(firstLogin.body.data.user, 'password'), false);
    const wrongPhone = await call(baseUrl, '/api/auth/patient-login', { method: 'POST', body: { mrn: patients[0].mrn, phone: '252600000000', password } });
    assert.equal(wrongPhone.status, 401);
    const staffLogin = await call(baseUrl, '/api/auth/login', { method: 'POST', body: { username: doctor.username, password } });
    assert.equal(staffLogin.status, 200, staffLogin.body.message);
    assert.equal(staffLogin.body.data.user.role, 'doctor');
    assert.equal((await call(baseUrl, '/api/patient-portal/profile', { token: staffLogin.body.data.token })).status, 403);
    assert.equal((await call(baseUrl, '/api/patient-portal/doctors', { token: staffLogin.body.data.token })).status, 403);
    const doctorDirectory = await call(baseUrl, '/api/patient-portal/doctors?page=1&limit=1&search=Synthetic%20Doctor', { token: firstToken });
    assert.equal(doctorDirectory.status, 200);
    assert.equal(doctorDirectory.body.data.pagination.total, 1);
    assert.deepEqual(Object.keys(doctorDirectory.body.data.doctors[0]).sort(), ['fullName', 'id']);
    assert.equal(doctorDirectory.body.data.doctors[0].id, doctor._id.toString());
    assert.equal(Object.hasOwn(doctorDirectory.body.data.doctors[0], 'username'), false);
    assert.equal((await call(baseUrl, '/api/patient-portal/doctors?role=admin', { token: firstToken })).status, 400);

    const secondLogin = await call(baseUrl, '/api/auth/patient-login', { method: 'POST', body: { mrn: patients[1].mrn, phone: '25261234561', password } });
    assert.equal(secondLogin.status, 200);
    const secondToken = secondLogin.body.data.token;
    const profile = await call(baseUrl, '/api/patient-portal/profile', { token: firstToken });
    assert.equal(profile.status, 200);
    assert.equal(profile.body.data.mrn, patients[0].mrn);
    const visits = await call(baseUrl, '/api/encounters?page=1&limit=10', { token: firstToken });
    assert.equal(visits.status, 200);
    assert.deepEqual(visits.body.data.encounters.map((row) => row.id), [encounters[0]._id.toString()]);
    assert.equal(JSON.stringify(visits.body).includes('PRIVATE'), false);
    const timeline = await call(baseUrl, `/api/patients/${patients[0]._id}/timeline`, { token: firstToken });
    assert.equal(timeline.status, 200);
    assert.equal(JSON.stringify(timeline.body).includes('PRIVATE'), false);
    assert.equal(JSON.stringify(timeline.body).includes('clinicalNotes'), false);
    assert.equal(JSON.stringify(timeline.body).includes('instructions'), false);
    const labs = await call(baseUrl, '/api/patient-portal/lab-results', { token: firstToken });
    assert.equal(labs.status, 200);
    assert.deepEqual(labs.body.data.results.map((row) => row.textValue), ['synthetic-result-0']);
    assert.equal(JSON.stringify(labs.body).includes('PRIVATE'), false);
    const prescriptions = await call(baseUrl, '/api/patient-portal/prescriptions', { token: firstToken });
    assert.equal(prescriptions.status, 200);
    assert.deepEqual(prescriptions.body.data.prescriptions.map((row) => row.drugName), ['Synthetic medication 0']);
    assert.equal(JSON.stringify(prescriptions.body).includes('PRIVATE'), false);

    assert.equal((await call(baseUrl, `/api/patient-portal/lab-results?patientId=${patients[1]._id}`, { token: firstToken })).status, 400);
    assert.equal((await call(baseUrl, `/api/encounters/${encounters[0]._id}`, { token: secondToken })).status, 404);
    assert.ok([403, 404].includes((await call(baseUrl, `/api/patients/${patients[0]._id}`, { token: secondToken })).status));
    assert.equal((await call(baseUrl, '/api/admin/access-logs', { token: firstToken })).status, 403);
    assert.equal((await call(baseUrl, '/api/admin/audit-logs', { token: firstToken })).status, 403);
    assert.ok(await AccessLog.exists({ patient: patients[0]._id, user: patientUsers[0]._id, accessMethod: 'patient_portal' }));
    assert.equal(await AccessLog.countDocuments({ patient: patients[1]._id, user: patientUsers[0]._id }), 0);

    const granted = await call(baseUrl, '/api/consents', { token: firstToken, method: 'POST', body: { doctorId: doctor._id.toString(), scope: 'clinical_record' } });
    assert.equal(granted.status, 201, granted.body.message);
    const consentList = await call(baseUrl, '/api/consents', { token: firstToken });
    assert.equal(consentList.status, 200);
    assert.equal(consentList.body.data.consents.length, 1);
    assert.equal(consentList.body.data.consents[0].status, 'granted');
    const otherConsent = await Consent.create({ patient: patients[1]._id, doctor: otherDoctor._id, grantedBy: patientUsers[1]._id });
    assert.equal((await call(baseUrl, `/api/consents/${otherConsent._id}/revoke`, { token: firstToken, method: 'PATCH', body: {} })).status, 404);
    assert.equal((await call(baseUrl, `/api/consents/${granted.body.data.id}/revoke`, { token: firstToken, method: 'PATCH', body: {} })).status, 200);
    assert.equal((await Consent.findById(granted.body.data.id).lean()).status, 'revoked');
    assert.equal(await AuditLog.countDocuments({ action: 'patient_consent_granted', entityId: granted.body.data.id }), 1);
    assert.equal(await AuditLog.countDocuments({ action: 'patient_consent_revoked', entityId: granted.body.data.id }), 1);

    const pdf = await call(baseUrl, '/api/patient-portal/summary.pdf', { token: firstToken, raw: true });
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.equal(pdf.headers.get('cache-control'), 'private, no-store');
    const pdfText = pdf.bytes.toString('ascii');
    assert.ok(pdfText.startsWith('%PDF-1.7'));
    assert.ok(pdfText.includes('/ToUnicode'));
    assert.ok(pdfText.includes('FontFile2'));
    assert.ok(pdfText.includes('NotoSans'));
    assert.equal(pdfText.includes('PRIVATE'), false);
    const verifyOutput = process.env.PATIENT_PORTAL_PDF_VERIFY_OUTPUT;
    if (verifyOutput) {
      const tempDirectory = `${path.resolve(os.tmpdir())}${path.sep}`;
      const outputPath = path.resolve(verifyOutput);
      if (!outputPath.startsWith(tempDirectory)) throw new Error('PDF verification output must stay inside the system temp directory');
      fs.writeFileSync(outputPath, pdf.bytes, { flag: 'w' });
      assert.equal(fs.statSync(outputPath).size, pdf.bytes.length);
    }

    const inactive = patientUsers[0];
    inactive.isActive = false;
    await inactive.save();
    assert.equal((await call(baseUrl, '/api/auth/patient-login', { method: 'POST', body: { mrn: patients[0].mrn, phone: '25261234560', password } })).status, 401);
    assert.equal((await call(baseUrl, '/api/patient-portal/profile', { token: firstToken })).status, 401);
    await t.test('patient portal login, ownership, field projections, consent, and PDF assertions executed against MongoDB', () => assert.ok(true));
  } catch (error) {
    console.error('Patient portal MongoDB integration failed:', error?.stack || error?.message || 'unknown test error');
    throw error;
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    if (connected && mongoose.connection.readyState === 1) {
      await mongoose.connection.dropDatabase();
      const remaining = await mongoose.connection.db.admin().command({
        listDatabases: 1,
        nameOnly: true,
        filter: { name: databaseName }
      });
      const databaseWasRemoved = !remaining.databases.some((database) => database.name === databaseName);
      await mongoose.disconnect();
      if (!databaseWasRemoved) throw new Error('The isolated patient portal test database was not removed');
    }
  }
});
