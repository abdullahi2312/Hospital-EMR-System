'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const User = require('../models/User');
const models = [
  require('../models/Patient'), require('../models/Encounter'), require('../models/LabOrder'),
  require('../models/LabResult'), require('../models/Prescription'), require('../models/Referral'),
  require('../models/Dispense'), require('../models/Payment'), require('../models/Inventory')
];
const { getOperationalAnalytics, normalizeRange } = require('../services/analytics.service');

const adminId = new mongoose.Types.ObjectId();
const doctorId = new mongoose.Types.ObjectId();
const oldUserFindById = User.findById;
const oldAggregates = models.map((model) => model.aggregate);

test.after(() => {
  User.findById = oldUserFindById;
  models.forEach((model, index) => { model.aggregate = oldAggregates[index]; });
});

test('admin analytics aggregates operational counts without returning record identifiers', async () => {
  User.findById = (id) => ({
    select() { return this; },
    lean: async () => String(id) === String(adminId) ? { _id: adminId, role: 'admin', isActive: true } : null
  });
  const rows = [
    [{ count: 3 }],
    [{ _id: 'closed', count: 1 }, { _id: 'open', count: 2 }],
    [{ _id: 'completed', count: 2 }, { _id: 'pending', count: 1 }],
    [{ _id: 'high', count: 1 }, { _id: 'normal', count: 2 }],
    [{ _id: 'pending', count: 2 }],
    [{ _id: 'accepted', count: 1 }],
    [{ _id: null, transactions: 4, units: 17 }],
    [{ _id: { status: 'simulated_success', currency: 'USD' }, count: 2, amount: 40 }],
    [{ _id: null, lots: 5, unitsOnHand: 92, lowStockLots: 1, expiredLots: 0, expiringWithin30Days: 2 }]
  ];
  models.forEach((model, index) => { model.aggregate = async () => rows[index]; });
  const result = await getOperationalAnalytics({ from: '2026-10-01', to: '2026-10-31' }, { id: adminId });
  assert.equal(result.patients.registrations, 3);
  assert.equal(result.encounters.byStatus.open, 2);
  assert.equal(result.laboratory.orders.byStatus.pending, 1);
  assert.equal(result.laboratory.results.byFlag.high, 1);
  assert.equal(result.prescriptions.byStatus.dispensed, 0);
  assert.equal(result.pharmacy.dispensing.units, 17);
  assert.equal(result.pharmacy.inventory.lowStockLots, 1);
  assert.equal(result.referrals.byStatus.accepted, 1);
  assert.equal(result.payments.simulated, true);
  assert.equal(result.payments.currencies.USD.totalAmount, 40);
  assert.doesNotMatch(JSON.stringify(result), /patientId|mrn|phone|doctorId|paymentReference/i);
});

test('analytics denies non-admins and inactive or missing current accounts', async () => {
  User.findById = (id) => ({
    select() { return this; },
    lean: async () => String(id) === String(doctorId)
      ? { _id: doctorId, role: 'doctor', isActive: true }
      : { _id: adminId, role: 'admin', isActive: false }
  });
  await assert.rejects(getOperationalAnalytics({}, { id: doctorId }), (error) => error.status === 403);
  await assert.rejects(getOperationalAnalytics({}, { id: adminId }), (error) => error.status === 401);
});

test('analytics validates strict UTC date filters, range order, and maximum duration', () => {
  assert.throws(() => normalizeRange({ from: '2026-02-30' }), /calendar date/);
  assert.throws(() => normalizeRange({ from: '2026-02-01', to: '2026-01-31' }), /range is invalid/);
  assert.throws(() => normalizeRange({ from: '2024-01-01', to: '2026-01-01' }), /cannot exceed/);
  assert.throws(() => normalizeRange({ patientId: 'not-supported' }), /only from and to/);
});

test('admin analytics route is mounted under the existing admin router with current-user authorization order', () => {
  const router = require('../routes/admin.routes');
  const route = router.stack.find((layer) => layer.route?.path === '/analytics')?.route;
  assert.ok(route);
  assert.equal(route.methods.get, true);
  assert.deepEqual(route.stack.map((layer) => layer.handle.name), ['authenticate', 'authorizeRequest', 'operationalAnalytics']);
  const app = require('../app');
  assert.equal(app.router.stack.filter((layer) => layer.handle === router).length, 1);
});

test('date-range aggregation fields have supporting model indexes', () => {
  const indexed = [
    [models[0], 'createdAt'], [models[1], 'createdAt'], [models[2], 'orderedAt'],
    [models[3], 'resultedAt'], [models[4], 'prescribedAt'], [models[5], 'referredAt'],
    [models[6], 'dispensedAt'], [models[7], 'createdAt']
  ];
  for (const [model, field] of indexed) {
    assert.equal(model.schema.indexes().some(([keys]) => Object.hasOwn(keys, field)), true, `${model.modelName}.${field}`);
  }
});

