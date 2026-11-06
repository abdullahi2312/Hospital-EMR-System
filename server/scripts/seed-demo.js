'use strict';

const mongoose = require('mongoose');
const { hashPassword } = require('../utils/password');
const User = require('../models/User');
const Patient = require('../models/Patient');
const Department = require('../models/Department');
const Medication = require('../models/Medication');
const Inventory = require('../models/Inventory');
const { ensureIndexes } = require('../config/ensure-indexes');

function validateDemoEnvironment() {
  const uri = process.env.MONGO_DEMO_URI;
  if (typeof uri !== 'string' || !uri) throw new Error('MONGO_DEMO_URI is required');
  let parsed;
  try {
    parsed = new URL(uri);
  } catch (_) {
    throw new Error('MONGO_DEMO_URI must be a valid MongoDB URI');
  }
  if (!['mongodb:', 'mongodb+srv:'].includes(parsed.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
    throw new Error('Demo seeding is restricted to a local MongoDB host');
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, '').split('/')[0] || '');
  if (!/^hospital_emr_demo(?:[_-][a-z0-9_-]+)?$/i.test(databaseName) || /prod/i.test(databaseName)) {
    throw new Error('Demo seeding requires a database named hospital_emr_demo or hospital_emr_demo_*');
  }
  if (parsed.username || parsed.password) throw new Error('Use a local demo-only MongoDB account without URI-embedded credentials');

  const password = process.env.DEMO_SEED_PASSWORD;
  if (typeof password !== 'string' || password.trim().length < 12 || Buffer.byteLength(password, 'utf8') > 72 || /^\$2[aby]\$\d{2}\$/.test(password)) {
    throw new Error('DEMO_SEED_PASSWORD must be a local-only plaintext password from 12 to 72 UTF-8 bytes');
  }
  if (typeof process.env.PATIENT_IDENTITY_HMAC_SECRET !== 'string' ||
      Buffer.byteLength(process.env.PATIENT_IDENTITY_HMAC_SECRET, 'utf8') < 32) {
    throw new Error('PATIENT_IDENTITY_HMAC_SECRET must be configured with at least 32 bytes');
  }
  return { uri, password };
}

async function ensureUser({ username, fullName, role, patient }) {
  let user = await User.findOne({ username });
  if (user && (user.role !== role || user.fullName !== fullName ||
      (patient && String(user.patient) !== String(patient._id)) || (!patient && user.patient))) {
    throw new Error(`Existing demo account ${username} does not match the expected demo identity; no overwrite was made`);
  }
  const passwordHash = await hashPassword(process.env.DEMO_SEED_PASSWORD);
  if (!user) user = new User({ username, fullName, role, ...(patient ? { patient: patient._id } : {}), isActive: true });
  user.password = passwordHash;
  user.isActive = true;
  await user.save();
  return user;
}

async function seedDemo() {
  const { uri, password } = validateDemoEnvironment();
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  await ensureIndexes();

  const admin = await ensureUser({ username: 'demo_admin', fullName: 'DEMO Admin Account', role: 'admin' });
  const receptionist = await ensureUser({ username: 'demo_receptionist', fullName: 'DEMO Receptionist Account', role: 'receptionist' });
  const doctor = await ensureUser({ username: 'demo_doctor', fullName: 'DEMO Doctor Account', role: 'doctor' });
  const lab = await ensureUser({ username: 'demo_lab', fullName: 'DEMO Lab Technician Account', role: 'lab_technician' });
  const pharmacist = await ensureUser({ username: 'demo_pharmacist', fullName: 'DEMO Pharmacist Account', role: 'pharmacist' });

  let patient = await Patient.findOne({ mrn: 'MRN-990001' });
  if (patient && (patient.firstName !== 'Tijaabo' || patient.fatherName !== 'Demo' || patient.grandfatherName !== 'Tusaale')) {
    throw new Error('Existing demo MRN is occupied by a different record; no overwrite was made');
  }
  if (!patient) {
    patient = new Patient({
      mrn: 'MRN-990001',
      firstName: 'Tijaabo',
      fatherName: 'Demo',
      grandfatherName: 'Tusaale',
      sex: 'female',
      estimatedAge: 30,
      district: 'DEMO ONLY',
      registeredBy: receptionist._id,
      allergyStatus: 'not_recorded'
    });
    await patient.save();
  }
  const portal = await ensureUser({ username: 'demo_patient', fullName: 'DEMO Patient Portal Account', role: 'patient', patient });

  let department = await Department.findOne({ code: 'DEMO' });
  if (!department) department = await Department.create({ name: 'DEMO Department', code: 'DEMO', description: 'Synthetic demo-only department' });
  if (department.isActive !== true) throw new Error('DEMO department is inactive; no data was changed beyond earlier idempotent seed records');

  let medication = await Medication.findOne({ name: 'demo paracetamol' });
  if (!medication) {
    medication = await Medication.create({
      name: 'DEMO Paracetamol', genericName: 'DEMO Paracetamol', category: 'DEMO', strength: '500 mg',
      dosageForm: 'tablet', route: 'oral', isActive: true, createdBy: admin._id
    });
  }
  if (medication.isActive !== true) throw new Error('DEMO medication is inactive; no data was changed beyond earlier idempotent seed records');

  let inventory = await Inventory.findOne({ medication: medication._id, batchNumber: 'DEMO-BATCH-001' });
  if (!inventory) {
    inventory = await Inventory.create({
      medication: medication._id, batchNumber: 'DEMO-BATCH-001', quantity: 50, minimumStock: 5,
      unit: 'tablets', expiryDate: new Date('2035-01-01T00:00:00.000Z'),
      supplier: 'DEMO ONLY', location: 'DEMO Pharmacy', lastUpdatedBy: pharmacist._id
    });
  }

  return {
    database: mongoose.connection.name,
    demoOnly: true,
    users: [admin, receptionist, doctor, lab, pharmacist, portal].map((user) => ({ username: user.username, id: user._id.toString(), role: user.role })),
    patient: { id: patient._id.toString(), mrn: patient.mrn },
    department: { id: department._id.toString(), code: department.code },
    medication: { id: medication._id.toString() },
    inventory: { id: inventory._id.toString() },
    passwordConfigured: Boolean(password)
  };
}

if (require.main === module) {
  seedDemo()
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return mongoose.disconnect();
    })
    .catch(async (error) => {
      process.stderr.write(`Demo seeding failed: ${error.message}\n`);
      await mongoose.disconnect().catch(() => {});
      process.exitCode = 1;
    });
}

module.exports = { seedDemo, validateDemoEnvironment };
