'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const mongoose = require('mongoose');

process.env.PAYMENT_FINGERPRINT_SECRET = 'payment-service-test-secret-at-least-32-random-bytes';

const Payment = require('../models/Payment');
const User = require('../models/User');
const Patient = require('../models/Patient');

const userId = new mongoose.Types.ObjectId();
const patientId = new mongoose.Types.ObjectId();
const otherUserId = new mongoose.Types.ObjectId();
const otherPatientId = new mongoose.Types.ObjectId();
let records;
let users;
let patients;
let auditEvents;
let auditCalls;
let failNextAudit;
let adapterCache;
let adapterCallCount;
let adapterOutcomeByPhone;

function copyRecord(record) {
  if (!record) return null;
  return {
    ...record,
    createdAt: record.createdAt ? new Date(record.createdAt) : record.createdAt,
    updatedAt: record.updatedAt ? new Date(record.updatedAt) : record.updatedAt
  };
}

function matches(record, filter) {
  return Object.entries(filter).every(([key, value]) => String(record[key]) === String(value));
}

function installModuleMock(request, exports) {
  const filename = require.resolve(request);
  const mockedModule = new Module(filename);
  mockedModule.filename = filename;
  mockedModule.loaded = true;
  mockedModule.exports = exports;
  require.cache[filename] = mockedModule;
}

const adapterMock = {
  async initiatePayment(input) {
    adapterCallCount += 1;
    const fingerprint = JSON.stringify(input);
    const prior = adapterCache.get(input.idempotencyKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        const error = new Error('simulated adapter idempotency conflict');
        error.code = 'IDEMPOTENCY_KEY_CONFLICT';
        throw error;
      }
      return { ...prior.result, createdAt: new Date(prior.result.createdAt) };
    }
    const outcome = adapterOutcomeByPhone.get(input.phoneNumber) || 'simulated_success';
    const result = {
      simulated: true,
      provider: 'simulated-mobile-money',
      paymentReference: `sim-mm-${input.idempotencyKey}`,
      status: outcome,
      amount: input.amount,
      currency: input.currency,
      createdAt: new Date()
    };
    adapterCache.set(input.idempotencyKey, { fingerprint, result });
    return { ...result, createdAt: new Date(result.createdAt) };
  }
};

const auditMock = {
  async writeAuditLog(input) {
    auditCalls.push(input);
    if (failNextAudit) {
      failNextAudit = false;
      throw new Error('mock audit failure');
    }
    if (auditEvents.has(input.paymentDeduplicationKey)) {
      return { deduplicated: true };
    }
    auditEvents.set(input.paymentDeduplicationKey, { ...input });
    return { id: new mongoose.Types.ObjectId().toString() };
  }
};

installModuleMock('../adapters/mobile-money.adapter', adapterMock);
installModuleMock('../services/audit-log.service', auditMock);
const {
  initiatePatientPayment,
  getPatientPaymentStatus,
  listPatientPayments
} = require('../services/payment.service');

function resetMocks() {
  records = [];
  users = new Map([
    [String(userId), { _id: userId, role: 'patient', patient: patientId, isActive: true }],
    [String(otherUserId), { _id: otherUserId, role: 'patient', patient: otherPatientId, isActive: true }]
  ]);
  patients = new Set([String(patientId), String(otherPatientId)]);
  auditEvents = new Map();
  auditCalls = [];
  failNextAudit = false;
  adapterCache = new Map();
  adapterCallCount = 0;
  adapterOutcomeByPhone = new Map();

  User.findById = (id) => ({
    select() { return this; },
    lean: async () => users.get(String(id)) || null
  });
  Patient.exists = async (filter) => patients.has(String(filter._id));

  Payment.findOne = (filter) => ({
    select() { return this; },
    lean: async () => copyRecord(records.find((record) => matches(record, filter)))
  });
  Payment.find = (filter) => {
    const query = {
      _sort: null,
      _skip: 0,
      _limit: Infinity,
      select() { return this; },
      sort(value) { this._sort = value; return this; },
      skip(value) { this._skip = value; return this; },
      limit(value) { this._limit = value; return this; },
      lean: async function leanMock() {
        let found = records.filter((record) => matches(record, filter));
        if (this._sort) found = found.sort((a, b) => b.createdAt - a.createdAt || String(b._id).localeCompare(String(a._id)));
        return found.slice(this._skip, this._skip + this._limit).map(copyRecord);
      }
    };
    return query;
  };
  Payment.prototype.save = async function saveMock() {
    await this.validate();
    const duplicate = records.some((record) => (
      String(record.initiatingUser) === String(this.initiatingUser) &&
      record.idempotencyKey === this.get('idempotencyKey')
    ));
    if (duplicate) {
      const error = new Error('mock duplicate key');
      error.code = 11000;
      throw error;
    }
    const record = this.toObject({ transform: false });
    records.push(record);
    return this;
  };
  Payment.transitionStatus = async (reference, nextStatus) => {
    const record = records.find((item) => item.paymentReference === reference && item.status === 'pending');
    if (!record) return null;
    record.status = nextStatus;
    record.updatedAt = new Date();
    return copyRecord(record);
  };
}

function patientUser(roleFromRequest = 'patient') {
  return { id: String(userId), role: roleFromRequest, patient: String(otherPatientId) };
}

function input(overrides = {}) {
  return {
    phoneNumber: '+252612345678',
    amount: 12.5,
    currency: 'USD',
    description: 'Registration charge',
    idempotencyKey: `payment-key-${Math.random().toString(16).slice(2, 10)}`,
    ...overrides
  };
}

function getByKey(key) {
  return records.find((record) => record.idempotencyKey === key);
}

test.beforeEach(resetMocks);

test('creates a simulated payment using database-linked patient identity and safe response fields', async () => {
  const paymentInput = input();
  const result = await initiatePatientPayment(paymentInput, patientUser('admin'));
  assert.equal(records.length, 1);
  assert.equal(String(records[0].initiatingUser), String(userId));
  assert.equal(String(records[0].patient), String(patientId));
  assert.equal(records[0].status, 'simulated_success');
  assert.equal(records[0].phoneNumber, undefined);
  assert.match(records[0].inputFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(result.simulated, true);
  assert.match(result.message, /no real money was transferred/);
  assert.equal(result.patient, String(patientId));
  for (const key of ['inputFingerprint', 'idempotencyKey', 'description', 'phoneNumber']) {
    assert.equal(Object.hasOwn(result, key), false);
  }
  assert.equal(adapterCallCount, 1);
  assert.equal(auditEvents.size, 2);
  assert.ok(auditCalls.every((event) => event.details === undefined));
  assert.ok(auditCalls.every((event) => !JSON.stringify(event).includes(paymentInput.phoneNumber)));
  assert.ok(auditCalls.every((event) => !JSON.stringify(event).includes(paymentInput.description)));
});

test('maps adapter pending and failed outcomes to the Payment schema statuses', async () => {
  const pendingInput = input({ phoneNumber: '+252612345671' });
  const failedInput = input({ phoneNumber: '+252612345672' });
  adapterOutcomeByPhone.set(pendingInput.phoneNumber, 'simulated_pending');
  adapterOutcomeByPhone.set(failedInput.phoneNumber, 'simulated_failure');
  const pending = await initiatePatientPayment(pendingInput, patientUser());
  const failed = await initiatePatientPayment(failedInput, patientUser());
  assert.equal(pending.status, 'pending');
  assert.equal(failed.status, 'simulated_failed');
  assert.equal(auditEvents.size, 3); // initiation for both plus one terminal status event
});

test('rejects missing, inactive, unlinked, and non-patient users using current database identity', async () => {
  await assert.rejects(initiatePatientPayment(input(), null), (error) => error.status === 401);
  await assert.rejects(initiatePatientPayment(input(), { id: 'not-an-object-id' }), (error) => error.status === 401);
  users.delete(String(userId));
  await assert.rejects(initiatePatientPayment(input(), patientUser()), (error) => error.status === 401);
  users.set(String(userId), { _id: userId, role: 'patient', patient: patientId, isActive: true });
  users.set(String(userId), { _id: userId, role: 'patient', patient: patientId, isActive: false });
  await assert.rejects(initiatePatientPayment(input(), patientUser()), (error) => error.status === 401);
  users.set(String(userId), { _id: userId, role: 'doctor', patient: undefined, isActive: true });
  await assert.rejects(initiatePatientPayment(input(), patientUser()), (error) => error.status === 403);
  users.set(String(userId), { _id: userId, role: 'patient', patient: undefined, isActive: true });
  await assert.rejects(initiatePatientPayment(input(), patientUser()), (error) => error.status === 403);
  users.set(String(userId), { _id: userId, role: 'patient', patient: patientId, isActive: true });
  patients.delete(String(patientId));
  await assert.rejects(initiatePatientPayment(input(), patientUser()), (error) => error.status === 403);
  assert.equal(records.length, 0);
});

test('validates payment values and rejects client-supplied identity or lifecycle fields', async () => {
  for (const bad of [
    { amount: 0 }, { amount: -1 }, { amount: NaN }, { amount: Infinity },
    { currency: 'EUR' }, { phoneNumber: '0612345678' }, { idempotencyKey: 'short' },
    { patientId: String(otherPatientId) }, { initiatingUser: String(otherUserId) },
    { status: 'simulated_success' }, { provider: 'real-provider' },
    { paymentReference: 'pay-spoofed' }, { inputFingerprint: 'a'.repeat(64) },
    { createdAt: new Date() }, { updatedAt: new Date() }, { pin: '1234' }, { otp: '000000' }
  ]) {
    await assert.rejects(initiatePatientPayment(input(bad), patientUser()), (error) => error.status === 400);
  }
  assert.equal(records.length, 0);
  assert.equal(adapterCallCount, 0);
});

test('same-key retry returns the persisted payment and does not invoke the adapter twice', async () => {
  const paymentInput = input();
  const first = await initiatePatientPayment(paymentInput, patientUser());
  const retry = await initiatePatientPayment(paymentInput, patientUser());
  assert.equal(retry.paymentReference, first.paymentReference);
  assert.equal(records.length, 1);
  assert.equal(adapterCallCount, 1);
  assert.equal(auditEvents.size, 2);
});

test('same-key different-input retry conflicts before adapter or database writes', async () => {
  const paymentInput = input();
  await initiatePatientPayment(paymentInput, patientUser());
  await assert.rejects(
    initiatePatientPayment({ ...paymentInput, phoneNumber: '+252612345679' }, patientUser()),
    (error) => error.status === 409 && /different payment input/.test(error.message)
  );
  assert.equal(records.length, 1);
  assert.equal(adapterCallCount, 1);
});

test('recovers a terminal payment and missing audit event after a simulated service restart', async () => {
  const paymentInput = input();
  const first = await initiatePatientPayment(paymentInput, patientUser());
  failNextAudit = true;
  // Force a fresh audit event on a later payment with a distinct key but keep
  // the persisted document as the source of truth for restart recovery.
  const recoveryInput = input({ idempotencyKey: `restart-${process.pid}-test` });
  failNextAudit = true;
  await assert.rejects(initiatePatientPayment(recoveryInput, patientUser()), (error) => (
    error.status === 503 && error.partialSuccess === true && Boolean(error.paymentReference)
  ));
  const persisted = getByKey(recoveryInput.idempotencyKey);
  assert.ok(persisted);
  assert.equal(persisted.status, 'simulated_success');
  const before = adapterCallCount;

  adapterCache = new Map(); // the adapter's process-local state is lost on restart
  const servicePath = require.resolve('../services/payment.service');
  delete require.cache[servicePath];
  const restartedService = require('../services/payment.service');
  const recovered = await restartedService.initiatePatientPayment(recoveryInput, patientUser());
  assert.equal(recovered.paymentReference, persisted.paymentReference);
  assert.equal(records.length, 2);
  assert.equal(adapterCallCount, before); // terminal DB record prevents adapter re-execution
  assert.equal(auditEvents.size, 4);
  assert.notEqual(first.paymentReference, recovered.paymentReference);
});

test('recovers a concurrent duplicate-key race without creating a second payment', async () => {
  const paymentInput = input();
  const results = await Promise.all([
    initiatePatientPayment(paymentInput, patientUser()),
    initiatePatientPayment(paymentInput, patientUser())
  ]);
  assert.equal(records.length, 1);
  assert.equal(results[0].paymentReference, results[1].paymentReference);
  assert.equal(auditEvents.size, 2);
});

test('status lookup hides another patient payment and returns only safe fields', async () => {
  const paymentInput = input();
  const created = await initiatePatientPayment(paymentInput, patientUser());
  const result = await getPatientPaymentStatus(created.paymentReference, patientUser());
  assert.equal(result.paymentReference, created.paymentReference);
  assert.equal(Object.hasOwn(result, 'inputFingerprint'), false);
  assert.equal(Object.hasOwn(result, 'description'), false);
  assert.equal(Object.hasOwn(result, 'idempotencyKey'), false);
  await assert.rejects(
    getPatientPaymentStatus(created.paymentReference, { id: String(otherUserId) }),
    (error) => error.status === 404 && error.message === 'Payment not found'
  );
  await assert.rejects(getPatientPaymentStatus('bad-reference', patientUser()), (error) => error.status === 400);
});

test('listing is patient-isolated, newest-first, and paginated safely', async () => {
  const firstInput = input({ idempotencyKey: `list-one-${process.pid}`, amount: 10 });
  const secondInput = input({ idempotencyKey: `list-two-${process.pid}`, amount: 11 });
  const thirdInput = input({ idempotencyKey: `list-three-${process.pid}`, amount: 12 });
  await initiatePatientPayment(firstInput, patientUser());
  await initiatePatientPayment(secondInput, patientUser());
  await initiatePatientPayment(thirdInput, patientUser());
  const otherPayment = new Payment({
    patient: otherPatientId,
    initiatingUser: otherUserId,
    amount: 40,
    currency: 'SOS',
    idempotencyKey: `other-user-${process.pid}`,
    inputFingerprint: Payment.createInputFingerprint({ phoneNumber: '+252612345678', amount: 40, currency: 'SOS', patientId: String(otherPatientId) })
  });
  await otherPayment.validate();
  records.push(otherPayment.toObject({ transform: false }));

  const page = await listPatientPayments({ page: '1', limit: '2' }, patientUser());
  assert.equal(page.payments.length, 2);
  assert.equal(page.pagination.page, 1);
  assert.equal(page.pagination.limit, 2);
  assert.equal(page.pagination.hasMore, true);
  assert.ok(page.payments.every((payment) => payment.patient === String(patientId)));
  assert.equal(page.payments.some((payment) => payment.patient === String(otherPatientId)), false);
  await assert.rejects(listPatientPayments({ limit: '101' }, patientUser()), (error) => error.status === 400);
  await assert.rejects(listPatientPayments({ page: '1.5' }, patientUser()), (error) => error.status === 400);
  await assert.rejects(listPatientPayments({ page: '10000', limit: '100' }, patientUser()), (error) => error.status === 413);
  await assert.rejects(listPatientPayments({ patientId: String(otherPatientId) }, patientUser()), (error) => error.status === 400);
});

test('audit failure is explicit partial success and same-key retry repairs audit without duplicating payment', async () => {
  const paymentInput = input();
  failNextAudit = true;
  await assert.rejects(
    initiatePatientPayment(paymentInput, patientUser()),
    (error) => error.status === 503 && error.partialSuccess === true && Boolean(error.paymentReference)
  );
  assert.equal(records.length, 1);
  const recovered = await initiatePatientPayment(paymentInput, patientUser());
  assert.equal(records.length, 1);
  assert.ok(recovered.paymentReference);
  assert.equal(auditEvents.size, 2);
});

test('missing fingerprint secret fails safely before payment or provider activity', async () => {
  const secret = process.env.PAYMENT_FINGERPRINT_SECRET;
  try {
    delete process.env.PAYMENT_FINGERPRINT_SECRET;
    await assert.rejects(
      initiatePatientPayment(input(), patientUser()),
      (error) => error.status === 503 && error.name === 'PaymentServiceError' && !error.message.includes('SECRET')
    );
  } finally {
    process.env.PAYMENT_FINGERPRINT_SECRET = secret;
  }
  assert.equal(records.length, 0);
  assert.equal(adapterCallCount, 0);
});
