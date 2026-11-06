'use strict';

const mongoose = require('mongoose');
const User = require('../models/User');
const Patient = require('../models/Patient');
const Encounter = require('../models/Encounter');
const LabOrder = require('../models/LabOrder');
const LabResult = require('../models/LabResult');
const Prescription = require('../models/Prescription');
const Inventory = require('../models/Inventory');
const Dispense = require('../models/Dispense');
const Referral = require('../models/Referral');
const Payment = require('../models/Payment');

const MAX_RANGE_DAYS = 366;
const STATUS_VALUES = {
  encounters: ['open', 'in_progress', 'closed'],
  labOrders: ['pending', 'sample_collected', 'processing', 'completed', 'sample_rejected', 'cancelled'],
  labResults: ['normal', 'high', 'low', 'unclassified'],
  prescriptions: ['pending', 'partially_dispensed', 'dispensed', 'cancelled'],
  referrals: ['pending', 'accepted', 'completed', 'cancelled'],
  payments: ['pending', 'simulated_success', 'simulated_failed']
};

function analyticsError(message, status = 400) {
  const error = new Error(message);
  error.name = 'AnalyticsServiceError';
  error.status = status;
  error.statusCode = status;
  return error;
}

function utcDate(value, field, endOfDay = false) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw analyticsError(`${field} must use YYYY-MM-DD format`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw analyticsError(`${field} is not a valid calendar date`);
  }
  if (endOfDay) date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

function normalizeRange(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some((key) => !['from', 'to'].includes(key))) {
    throw analyticsError('Analytics filters may contain only from and to dates');
  }
  const now = new Date();
  const toDay = options.to === undefined ? now.toISOString().slice(0, 10) : options.to;
  const fromDay = options.from === undefined
    ? new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    : options.from;
  const from = utcDate(fromDay, 'from');
  const toExclusive = utcDate(toDay, 'to', true);
  if (from >= toExclusive) throw analyticsError('Date range is invalid');
  const days = (toExclusive.getTime() - from.getTime()) / (24 * 60 * 60 * 1000);
  if (days > MAX_RANGE_DAYS) throw analyticsError(`Date range cannot exceed ${MAX_RANGE_DAYS} days`);
  return { from, toExclusive, fromDate: fromDay, toDate: toDay };
}

function dateMatch(field, range) {
  return { [field]: { $gte: range.from, $lt: range.toExclusive } };
}

async function aggregate(Model, pipeline, label) {
  try {
    return await Model.aggregate(pipeline);
  } catch (_) {
    throw analyticsError(`Unable to retrieve ${label} analytics`, 503);
  }
}

async function groupedCount(Model, dateField, groupField, range, label) {
  return aggregate(Model, [
    { $match: dateMatch(dateField, range) },
    { $group: { _id: `$${groupField}`, count: { $sum: 1 } } },
    { $sort: { _id: 1 } }
  ], label);
}

function statusSummary(rows, allowedStatuses) {
  const summary = Object.fromEntries(allowedStatuses.map((status) => [status, 0]));
  for (const row of rows) {
    if (Object.hasOwn(summary, row._id)) summary[row._id] = row.count;
  }
  return summary;
}

async function requireActiveAdmin(user) {
  if (!user || typeof user !== 'object' || !mongoose.isObjectIdOrHexString(user.id)) {
    throw analyticsError('Authentication required', 401);
  }
  let account;
  try {
    account = await User.findById(String(user.id)).select('_id role isActive').lean();
  } catch (_) {
    throw analyticsError('Unable to verify analytics access', 503);
  }
  if (!account || account.isActive !== true) throw analyticsError('Authentication required', 401);
  if (account.role !== 'admin') throw analyticsError('Analytics access is restricted to administrators', 403);
}

async function getOperationalAnalytics(options, user) {
  await requireActiveAdmin(user);
  const range = normalizeRange(options);
  const inventoryAsOf = new Date();
  const expiringCutoff = new Date(inventoryAsOf.getTime() + 30 * 24 * 60 * 60 * 1000);
  const [
    patients,
    encounterRows,
    labOrderRows,
    labResultRows,
    prescriptionRows,
    referralRows,
    dispenseRows,
    paymentRows,
    inventoryRows
  ] = await Promise.all([
    aggregate(Patient, [
      { $match: dateMatch('createdAt', range) },
      { $count: 'count' }
    ], 'patient registration'),
    groupedCount(Encounter, 'createdAt', 'status', range, 'encounter'),
    groupedCount(LabOrder, 'orderedAt', 'status', range, 'laboratory order'),
    groupedCount(LabResult, 'resultedAt', 'flag', range, 'laboratory result'),
    groupedCount(Prescription, 'prescribedAt', 'status', range, 'prescription'),
    groupedCount(Referral, 'referredAt', 'status', range, 'referral'),
    aggregate(Dispense, [
      { $match: dateMatch('dispensedAt', range) },
      { $group: { _id: null, transactions: { $sum: 1 }, units: { $sum: '$quantityDispensed' } } }
    ], 'dispensing'),
    aggregate(Payment, [
      { $match: dateMatch('createdAt', range) },
      { $group: { _id: { status: '$status', currency: '$currency' }, count: { $sum: 1 }, amount: { $sum: '$amount' } } },
      { $sort: { '_id.currency': 1, '_id.status': 1 } }
    ], 'payment'),
    aggregate(Inventory, [{
      $group: {
        _id: null,
        lots: { $sum: 1 },
        unitsOnHand: { $sum: '$quantity' },
        lowStockLots: { $sum: { $cond: [{ $lte: ['$quantity', '$minimumStock'] }, 1, 0] } },
        expiredLots: { $sum: { $cond: [{ $lt: ['$expiryDate', inventoryAsOf] }, 1, 0] } },
        expiringWithin30Days: { $sum: { $cond: [{ $and: [{ $gte: ['$expiryDate', inventoryAsOf] }, { $lt: ['$expiryDate', expiringCutoff] }] }, 1, 0] } }
      }
    }], 'inventory')
  ]);

  const payments = {};
  for (const row of paymentRows) {
    const currency = row._id.currency;
    if (!['USD', 'SOS'].includes(currency) || !STATUS_VALUES.payments.includes(row._id.status)) continue;
    payments[currency] ||= { totalCount: 0, totalAmount: 0, byStatus: statusSummary([], STATUS_VALUES.payments) };
    payments[currency].totalCount += row.count;
    payments[currency].totalAmount = Number((payments[currency].totalAmount + row.amount).toFixed(2));
    payments[currency].byStatus[row._id.status] += row.count;
  }

  return {
    period: { from: range.fromDate, to: range.toDate },
    patients: { registrations: patients[0]?.count || 0 },
    encounters: { total: encounterRows.reduce((sum, row) => sum + row.count, 0), byStatus: statusSummary(encounterRows, STATUS_VALUES.encounters) },
    laboratory: {
      orders: { total: labOrderRows.reduce((sum, row) => sum + row.count, 0), byStatus: statusSummary(labOrderRows, STATUS_VALUES.labOrders) },
      results: { total: labResultRows.reduce((sum, row) => sum + row.count, 0), byFlag: statusSummary(labResultRows, STATUS_VALUES.labResults) }
    },
    prescriptions: { total: prescriptionRows.reduce((sum, row) => sum + row.count, 0), byStatus: statusSummary(prescriptionRows, STATUS_VALUES.prescriptions) },
    pharmacy: {
      inventory: {
        lots: inventoryRows[0]?.lots || 0,
        unitsOnHand: inventoryRows[0]?.unitsOnHand || 0,
        lowStockLots: inventoryRows[0]?.lowStockLots || 0,
        expiredLots: inventoryRows[0]?.expiredLots || 0,
        expiringWithin30Days: inventoryRows[0]?.expiringWithin30Days || 0,
        measuredAt: inventoryAsOf
      },
      dispensing: { transactions: dispenseRows[0]?.transactions || 0, units: dispenseRows[0]?.units || 0 }
    },
    referrals: { total: referralRows.reduce((sum, row) => sum + row.count, 0), byStatus: statusSummary(referralRows, STATUS_VALUES.referrals) },
    payments: { simulated: true, currencies: payments }
  };
}

module.exports = { getOperationalAnalytics, normalizeRange };
