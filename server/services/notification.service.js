'use strict';

const crypto = require('node:crypto');
const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const User = require('../models/User');

const PAGE_MAX = 100;

function notificationError(message, status = 400) {
  const error = new Error(message);
  error.name = 'NotificationServiceError';
  error.status = status;
  error.statusCode = status;
  return error;
}

function validObjectId(value) {
  return mongoose.isObjectIdOrHexString(value);
}

function deterministicIdempotencyId(key) {
  return new mongoose.Types.ObjectId(crypto.createHash('sha256').update(`notification:${key}`).digest().subarray(0, 12));
}

function serialize(notification) {
  return {
    id: String(notification._id),
    ...(notification.patient ? { patient: String(notification.patient) } : {}),
    type: notification.type,
    title: notification.title,
    message: notification.message,
    ...(notification.relatedModel ? { relatedModel: notification.relatedModel } : {}),
    ...(notification.relatedId ? { relatedId: String(notification.relatedId) } : {}),
    isRead: Boolean(notification.isRead),
    ...(notification.readAt ? { readAt: notification.readAt } : {}),
    createdAt: notification.createdAt
  };
}

async function createNotificationOnce(input) {
  const allowed = new Set(['recipient', 'patient', 'type', 'title', 'message', 'relatedModel', 'relatedId', 'eventKey']);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !allowed.has(key))) {
    throw notificationError('Notification input is invalid');
  }
  if (!validObjectId(input.recipient) || (input.patient !== undefined && !validObjectId(input.patient)) ||
      (input.relatedId !== undefined && !validObjectId(input.relatedId))) {
    throw notificationError('Notification references are invalid');
  }
  if (!['lab_result_ready', 'break_glass_alert', 'medication_unavailable', 'referral_update', 'general'].includes(input.type)) {
    throw notificationError('Notification type is invalid');
  }
  if (typeof input.eventKey !== 'string' || input.eventKey.trim().length < 8 || input.eventKey.length > 200) {
    throw notificationError('A valid notification event key is required');
  }
  for (const field of ['title', 'message']) {
    if (typeof input[field] !== 'string' || !input[field].trim() || input[field].trim().length > (field === 'title' ? 200 : 5000)) {
      throw notificationError(`Notification ${field} is invalid`);
    }
  }

  let recipient;
  try {
    recipient = await User.findById(String(input.recipient)).select('_id isActive').lean();
  } catch (_) {
    throw notificationError('Unable to verify notification recipient', 503);
  }
  if (!recipient || recipient.isActive !== true) throw notificationError('Notification recipient is unavailable', 404);

  const _id = deterministicIdempotencyId(input.eventKey.trim());
  const values = {
    _id,
    recipient: recipient._id,
    ...(input.patient ? { patient: input.patient } : {}),
    type: input.type,
    title: input.title.trim(),
    message: input.message.trim(),
    ...(input.relatedModel ? { relatedModel: input.relatedModel } : {}),
    ...(input.relatedId ? { relatedId: input.relatedId } : {})
  };
  try {
    const created = await Notification.create(values);
    return { ...serialize(created), replayed: false };
  } catch (error) {
    if (error.code !== 11000) {
      if (error.name === 'ValidationError' || error.name === 'CastError' || error.name === 'StrictModeError') {
        throw notificationError('Notification data is invalid');
      }
      throw notificationError('Unable to save notification', 503);
    }
  }

  let existing;
  try {
    existing = await Notification.findById(_id).lean();
  } catch (_) {
    throw notificationError('Unable to confirm notification retry', 503);
  }
  if (!existing || String(existing.recipient) !== String(values.recipient) ||
      String(existing.patient || '') !== String(values.patient || '') || existing.type !== values.type ||
      existing.title !== values.title || existing.message !== values.message ||
      String(existing.relatedModel || '') !== String(values.relatedModel || '') ||
      String(existing.relatedId || '') !== String(values.relatedId || '')) {
    throw notificationError('Notification event key conflicts with another event', 409);
  }
  return { ...serialize(existing), replayed: true };
}

function positiveInteger(value, field, fallback, max) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw notificationError(`${field} must be a positive whole number`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) throw notificationError(`${field} must be between 1 and ${max}`);
  return parsed;
}

async function activeAccount(user) {
  if (!user || !validObjectId(user.id)) throw notificationError('Authentication required', 401);
  let account;
  try {
    account = await User.findById(String(user.id)).select('_id isActive').lean();
  } catch (_) {
    throw notificationError('Unable to verify authenticated user', 503);
  }
  if (!account || account.isActive !== true) throw notificationError('Authentication required', 401);
  return account;
}

async function listMyNotifications(options, user) {
  const account = await activeAccount(user);
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some((key) => !['page', 'limit', 'unreadOnly'].includes(key))) {
    throw notificationError('Notification list filters are invalid');
  }
  const page = positiveInteger(options.page, 'Page', 1, 100000);
  const limit = positiveInteger(options.limit, 'Limit', 20, PAGE_MAX);
  const unreadOnly = options.unreadOnly === undefined ? false
    : options.unreadOnly === 'true' ? true
      : options.unreadOnly === 'false' ? false
        : (() => { throw notificationError('unreadOnly must be true or false'); })();
  const skip = (page - 1) * limit;
  if (skip > 100000) throw notificationError('Requested page exceeds the supported notification history window', 413);
  let records;
  try {
    records = await Notification.find({ recipient: account._id, ...(unreadOnly ? { isRead: false } : {}) })
      .select('_id patient type title message relatedModel relatedId isRead readAt createdAt')
      .sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit + 1).lean();
  } catch (_) {
    throw notificationError('Unable to retrieve notifications', 503);
  }
  return { notifications: records.slice(0, limit).map(serialize), pagination: { page, limit, hasMore: records.length > limit } };
}

async function markMyNotificationRead(notificationId, user) {
  const account = await activeAccount(user);
  if (!validObjectId(notificationId)) throw notificationError('A valid notification ID is required');
  let notification;
  try {
    notification = await Notification.findOneAndUpdate(
      { _id: notificationId, recipient: account._id, isRead: false },
      { $set: { isRead: true } },
      { new: true, runValidators: true }
    ).lean();
    if (!notification) {
      notification = await Notification.findOne({ _id: notificationId, recipient: account._id })
        .select('_id patient type title message relatedModel relatedId isRead readAt createdAt').lean();
    }
  } catch (_) {
    throw notificationError('Unable to update notification status', 503);
  }
  if (!notification) throw notificationError('Notification not found', 404);
  return serialize(notification);
}

module.exports = { createNotificationOnce, listMyNotifications, markMyNotificationRead };
