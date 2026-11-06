'use strict';

const mongoose = require('mongoose');
const AuditLog = require('../models/AuditLog');

const MAX_PAGE = 1000000;
const MAX_LIMIT = 100;
const ALLOWED_FILTERS = new Set([
  'page', 'limit', 'actorId', 'action', 'entityType', 'entityId', 'fromDate', 'toDate'
]);

function reviewError(message, status = 400) {
  const error = new Error(message);
  error.name = 'AuditLogReviewError';
  error.status = status;
  return error;
}

function positiveInteger(value, field, fallback, maximum) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw reviewError(`${field} must be a positive whole number`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw reviewError(`${field} must be between 1 and ${maximum}`);
  }
  return parsed;
}

function parseDate(value, field, endOfDay = false) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) {
    throw reviewError(`${field} must be a valid ISO date or datetime`);
  }
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const calendarDate = new Date(0);
  calendarDate.setUTCHours(0, 0, 0, 0);
  calendarDate.setUTCFullYear(year, month - 1, day);
  if (calendarDate.getUTCFullYear() !== year || calendarDate.getUTCMonth() !== month - 1 || calendarDate.getUTCDate() !== day) {
    throw reviewError(`${field} must be a valid ISO date or datetime`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw reviewError(`${field} must be a valid ISO date or datetime`);
  if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(value)) date.setUTCHours(23, 59, 59, 999);
  return date;
}

function safeRecord(record) {
  return {
    id: String(record._id),
    actorId: String(record.actor),
    action: record.action,
    entityType: record.entityType,
    ...(record.entityId ? { entityId: String(record.entityId) } : {}),
    createdAt: record.createdAt
  };
}

async function listAuditLogs(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw reviewError('Audit-log filters must be an object');
  }
  if (Object.keys(options).some((key) => !ALLOWED_FILTERS.has(key))) {
    throw reviewError('Unsupported audit-log filter');
  }

  const page = positiveInteger(options.page, 'page', 1, MAX_PAGE);
  const limit = positiveInteger(options.limit, 'limit', 20, MAX_LIMIT);
  const filter = {};

  for (const [inputName, field] of [['actorId', 'actor'], ['entityId', 'entityId']]) {
    const value = options[inputName];
    if (value !== undefined) {
      if (typeof value !== 'string' || !mongoose.isObjectIdOrHexString(value)) {
        throw reviewError(`${inputName} must be a valid ObjectId`);
      }
      filter[field] = new mongoose.Types.ObjectId(value);
    }
  }

  for (const field of ['action', 'entityType']) {
    const value = options[field];
    if (value !== undefined) {
      if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > (field === 'action' ? 120 : 100)) {
        throw reviewError(`${field} must be a non-empty value within the allowed length`);
      }
      filter[field] = value.trim();
    }
  }

  const fromDate = parseDate(options.fromDate, 'fromDate');
  const toDate = parseDate(options.toDate, 'toDate', true);
  if (fromDate && toDate && fromDate > toDate) {
    throw reviewError('fromDate must be earlier than or equal to toDate');
  }
  if (fromDate || toDate) {
    filter.createdAt = {
      ...(fromDate ? { $gte: fromDate } : {}),
      ...(toDate ? { $lte: toDate } : {})
    };
  }

  try {
    const [records, total] = await Promise.all([
      AuditLog.find(filter)
        .select('_id actor action entityType entityId createdAt')
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      AuditLog.countDocuments(filter)
    ]);

    return {
      logs: records.map(safeRecord),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
    };
  } catch (_) {
    throw reviewError('Unable to retrieve audit logs', 500);
  }
}

module.exports = { listAuditLogs };
