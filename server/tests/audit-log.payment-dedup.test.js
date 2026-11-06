'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const { writeAuditLog } = require('../services/audit-log.service');

const actorId = new mongoose.Types.ObjectId();
const paymentId = new mongoose.Types.ObjectId();
const deduplicationKey = 'a'.repeat(64);
const originalUserFindById = User.findById;
const originalAuditSave = AuditLog.prototype.save;
const originalAuditFindOne = AuditLog.findOne;

function mockActorLookup() {
  User.findById = () => ({
    select() { return this; },
    lean: async () => ({ _id: actorId })
  });
}

function restoreModels() {
  User.findById = originalUserFindById;
  AuditLog.prototype.save = originalAuditSave;
  AuditLog.findOne = originalAuditFindOne;
}

test('declares an optional sparse-by-partial unique payment deduplication index', () => {
  const path = AuditLog.schema.path('paymentDeduplicationKey');
  assert.ok(path);
  assert.equal(path.options.immutable, true);
  assert.equal(path.options.select, false);
  const index = AuditLog.schema.indexes().find(([keys]) => keys.paymentDeduplicationKey === 1);
  assert.ok(index);
  assert.equal(index[1].unique, true);
  assert.deepEqual(index[1].partialFilterExpression, { paymentDeduplicationKey: { $type: 'string' } });
});

test('declares a private partial unique patient registration audit key', () => {
  const path = AuditLog.schema.path('patientRegistrationDeduplicationKey');
  assert.ok(path);
  assert.equal(path.options.immutable, true);
  assert.equal(path.options.select, false);
  const index = AuditLog.schema.indexes().find(([keys]) => keys.patientRegistrationDeduplicationKey === 1);
  assert.ok(index);
  assert.equal(index[1].unique, true);
  assert.deepEqual(index[1].partialFilterExpression, {
    patientRegistrationDeduplicationKey: { $type: 'string' }
  });
});

test('payment audit events require a valid deduplication key; non-payment events remain optional', async () => {
  mockActorLookup();
  AuditLog.prototype.save = async function saveMock() { return this; };
  try {
    await assert.rejects(
      writeAuditLog({ actorId, action: 'payment_initiated', entityType: 'Payment', entityId: paymentId }),
      /deduplication key is required/
    );
    await assert.rejects(
      writeAuditLog({ actorId, action: 'payment_initiated', entityType: 'Payment', entityId: paymentId, paymentDeduplicationKey: 'raw-key' }),
      /deduplication key is invalid/
    );
    await assert.rejects(
      writeAuditLog({ actorId, action: 'patient_registered', entityType: 'Patient', paymentDeduplicationKey: deduplicationKey }),
      /only valid for payment audit events/
    );
    await assert.rejects(
      writeAuditLog({ actorId, action: 'patient_registered', entityType: 'Patient', patientRegistrationDeduplicationKey: 'raw-key' }),
      /patient registration audit deduplication key is invalid/i
    );
    await assert.rejects(
      writeAuditLog({ actorId, action: 'patient_directory_listed', entityType: 'Patient', patientRegistrationDeduplicationKey: deduplicationKey }),
      /only valid for patient registration events/i
    );

    const result = await writeAuditLog({ actorId, action: 'patient_registered', entityType: 'Patient', entityId: paymentId });
    assert.equal(result.action, 'patient_registered');
    assert.equal(result.deduplicated, undefined);
  } finally {
    restoreModels();
  }
});

test('concurrent patient registration audit retries resolve to one durable event', async () => {
  mockActorLookup();
  const patientRegistrationKey = 'b'.repeat(64);
  const persisted = [];
  let saveAttempts = 0;
  AuditLog.prototype.save = async function savePatientRaceMock() {
    saveAttempts += 1;
    if (saveAttempts === 1) {
      persisted.push(this);
      return this;
    }
    const duplicate = new Error('duplicate key detail must not escape');
    duplicate.code = 11000;
    throw duplicate;
  };
  AuditLog.findOne = (filter) => ({
    select() { return this; },
    lean: async () => {
      const event = persisted.find((candidate) => candidate.patientRegistrationDeduplicationKey === filter.patientRegistrationDeduplicationKey);
      return event ? {
        _id: event._id,
        actor: event.actor,
        action: event.action,
        entityType: event.entityType,
        entityId: event.entityId,
        createdAt: event.createdAt
      } : null;
    }
  });
  try {
    const input = {
      actorId,
      action: 'patient_registered',
      entityType: 'Patient',
      entityId: paymentId,
      patientRegistrationDeduplicationKey: patientRegistrationKey
    };
    const results = await Promise.all([writeAuditLog(input), writeAuditLog(input)]);
    assert.equal(saveAttempts, 2);
    assert.equal(persisted.length, 1);
    assert.equal(results[0].id, results[1].id);
    assert.ok(results.some((result) => result.deduplicated === true));
    assert.equal(Object.hasOwn(results[0], 'patientRegistrationDeduplicationKey'), false);
    assert.equal(Object.hasOwn(results[1], 'patientRegistrationDeduplicationKey'), false);
  } finally {
    restoreModels();
  }
});

test('concurrent duplicate payment audit insertions return the existing event once', async () => {
  mockActorLookup();
  const persisted = [];
  let saveAttempts = 0;
  AuditLog.prototype.save = async function saveRaceMock() {
    saveAttempts += 1;
    if (saveAttempts === 1) {
      persisted.push(this);
      return this;
    }
    const duplicate = new Error('duplicate index detail must not escape');
    duplicate.code = 11000;
    throw duplicate;
  };
  AuditLog.findOne = (filter) => ({
    select() { return this; },
    lean: async () => {
      const event = persisted.find((candidate) => candidate.paymentDeduplicationKey === filter.paymentDeduplicationKey);
      return event ? {
        _id: event._id,
        actor: event.actor,
        action: event.action,
        entityType: event.entityType,
        entityId: event.entityId,
        createdAt: event.createdAt
      } : null;
    }
  });

  try {
    const input = {
      actorId,
      action: 'payment_initiated',
      entityType: 'Payment',
      entityId: paymentId,
      paymentDeduplicationKey: deduplicationKey,
      details: { outcome: 'simulated_success' }
    };
    const results = await Promise.all([writeAuditLog(input), writeAuditLog(input)]);
    assert.equal(saveAttempts, 2);
    assert.equal(persisted.length, 1);
    assert.equal(results[0].id, results[1].id);
    assert.ok(results.some((result) => result.deduplicated === true));
    assert.equal(Object.hasOwn(results[0], 'paymentDeduplicationKey'), false);
    assert.equal(Object.hasOwn(results[1], 'paymentDeduplicationKey'), false);
  } finally {
    restoreModels();
  }
});

test('concurrent stock-addition audit retries recover the unique nested-key event', async () => {
  mockActorLookup();
  const stockKey = 'd'.repeat(64);
  const details = {
    quantityAdded: 4,
    operationHash: 'e'.repeat(64),
    stockAdditionDeduplicationKey: stockKey
  };
  const persisted = [];
  let saveAttempts = 0;
  AuditLog.prototype.save = async function saveStockRaceMock() {
    saveAttempts += 1;
    if (saveAttempts === 1) {
      persisted.push(this);
      return this;
    }
    const duplicate = new Error('unique stock audit index detail');
    duplicate.code = 11000;
    throw duplicate;
  };
  AuditLog.findOne = (filter) => ({
    select() { return this; },
    lean: async () => {
      const event = persisted.find((candidate) => (
        String(candidate.actor) === String(filter.actor) &&
        String(candidate.entityId) === String(filter.entityId) &&
        candidate.details?.stockAdditionDeduplicationKey === filter['details.stockAdditionDeduplicationKey']
      ));
      return event ? {
        _id: event._id,
        actor: event.actor,
        action: event.action,
        entityType: event.entityType,
        entityId: event.entityId,
        details: event.details,
        createdAt: event.createdAt
      } : null;
    }
  });

  try {
    await assert.rejects(
      writeAuditLog({ actorId, action: 'inventory_stock_added', entityType: 'Inventory', entityId: paymentId }),
      /deduplication key is required/
    );
    await assert.rejects(
      writeAuditLog({
        actorId,
        action: 'inventory_stock_added',
        entityType: 'Inventory',
        entityId: paymentId,
        details: { operationHash: 'invalid', stockAdditionDeduplicationKey: 'd'.repeat(64) }
      }),
      /operation fingerprint is invalid/
    );
    const input = {
      actorId,
      action: 'inventory_stock_added',
      entityType: 'Inventory',
      entityId: paymentId,
      details
    };
    const results = await Promise.all([writeAuditLog(input), writeAuditLog(input)]);
    assert.equal(saveAttempts, 2);
    assert.equal(persisted.length, 1);
    assert.equal(results[0].id, results[1].id);
    assert.ok(results.some((result) => result.deduplicated === true));
  } finally {
    restoreModels();
  }
});

test('a colliding payment deduplication key for a different event returns a safe conflict', async () => {
  mockActorLookup();
  AuditLog.prototype.save = async function duplicateMock() {
    const duplicate = new Error('index internals');
    duplicate.code = 11000;
    throw duplicate;
  };
  AuditLog.findOne = () => ({
    select() { return this; },
    lean: async () => ({
      _id: new mongoose.Types.ObjectId(),
      actor: actorId,
      action: 'payment_status_changed',
      entityType: 'Payment',
      entityId: new mongoose.Types.ObjectId(),
      createdAt: new Date()
    })
  });
  try {
    await assert.rejects(
      writeAuditLog({
        actorId,
        action: 'payment_initiated',
        entityType: 'Payment',
        entityId: paymentId,
        paymentDeduplicationKey: deduplicationKey
      }),
      (error) => error.name === 'AuditLogServiceError' && error.status === 409 &&
        !error.message.includes('index internals')
    );
  } finally {
    restoreModels();
  }
});

test('existing AuditLog sensitive details validation and append-only schema remain enabled', async () => {
  const valid = new AuditLog({ actor: actorId, action: 'patient_registered', entityType: 'Patient' });
  await valid.validate();
  const registrationAudit = new AuditLog({
    actor: actorId,
    action: 'patient_registered',
    entityType: 'Patient',
    entityId: paymentId,
    patientRegistrationDeduplicationKey: 'c'.repeat(64)
  });
  await registrationAudit.validate();
  assert.equal(registrationAudit.patientRegistrationDeduplicationKey, 'c'.repeat(64));
  const stockAuditWithDigitHeavyDigests = new AuditLog({
    actor: actorId,
    action: 'inventory_stock_added',
    entityType: 'Inventory',
    entityId: paymentId,
    details: {
      quantityAdded: 4,
      operationHash: '1'.repeat(64),
      stockAdditionDeduplicationKey: '2'.repeat(64)
    }
  });
  await stockAuditWithDigitHeavyDigests.validate();
  const invalid = new AuditLog({
    actor: actorId,
    action: 'patient_registered',
    entityType: 'Patient',
    details: { phoneNumber: '+252612345678' }
  });
  await assert.rejects(invalid.validate());
  assert.equal(AuditLog.schema.path('actor').options.immutable, true);
  assert.equal(AuditLog.schema.path('details').options.immutable, true);
  await assert.rejects(
    AuditLog.bulkWrite([{ updateOne: { filter: {}, update: { $set: { action: 'rewritten' } } } }]),
    /append-only/
  );
});
