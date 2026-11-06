const mongoose = require('mongoose');
const AccessLog = require('../models/AccessLog');

const MAX_PAGE = 1000000;
const MAX_LIMIT = 100;

function reviewError(message, status = 400) {
  const error = new Error(message);
  error.name = 'AccessLogReviewError';
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
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw reviewError(`${field} must be a valid ISO date or datetime`);
  if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    date.setUTCHours(23, 59, 59, 999);
  }
  return date;
}

function safeRecord(record) {
  return {
    id: String(record._id),
    patient: String(record.patient),
    user: String(record.user),
    ...(record.encounter ? { encounter: String(record.encounter) } : {}),
    ...(record.consent ? { consent: String(record.consent) } : {}),
    ...(record.breakGlass ? { breakGlass: String(record.breakGlass) } : {}),
    action: record.action,
    accessMethod: record.accessMethod,
    ...(record.accessReason ? { accessReason: record.accessReason } : {}),
    accessedAt: record.accessedAt
  };
}

async function listAccessLogs(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw reviewError('Access-log filters must be an object');
  }
  const allowed = new Set(['page', 'limit', 'patientId', 'actorId', 'fromDate', 'toDate']);
  if (Object.keys(options).some((key) => !allowed.has(key))) {
    throw reviewError('Unsupported access-log filter');
  }

  const page = positiveInteger(options.page, 'page', 1, MAX_PAGE);
  const limit = positiveInteger(options.limit, 'limit', 20, MAX_LIMIT);
  const filter = {};

  for (const [inputName, field] of [['patientId', 'patient'], ['actorId', 'user']]) {
    const value = options[inputName];
    if (value !== undefined) {
      if (typeof value !== 'string' || !mongoose.isObjectIdOrHexString(value)) {
        throw reviewError(`${inputName} must be a valid ObjectId`);
      }
      filter[field] = new mongoose.Types.ObjectId(value);
    }
  }

  const fromDate = parseDate(options.fromDate, 'fromDate');
  const toDate = parseDate(options.toDate, 'toDate', true);
  if (fromDate && toDate && fromDate > toDate) {
    throw reviewError('fromDate must be earlier than or equal to toDate');
  }
  if (fromDate || toDate) {
    filter.accessedAt = {
      ...(fromDate ? { $gte: fromDate } : {}),
      ...(toDate ? { $lte: toDate } : {})
    };
  }

  try {
    const [records, total] = await Promise.all([
      AccessLog.find(filter)
        .select('_id patient user encounter consent breakGlass action accessMethod accessReason accessedAt')
        .sort({ accessedAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      AccessLog.countDocuments(filter)
    ]);

    return {
      logs: records.map(safeRecord),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
    };
  } catch (error) {
    if (error.name === 'AccessLogReviewError') throw error;
    throw reviewError('Unable to retrieve access logs', 500);
  }
}

module.exports = { listAccessLogs };
