'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const User = require('../models/User');
const Notification = require('../models/Notification');
const { createNotificationOnce, listMyNotifications, markMyNotificationRead } = require('../services/notification.service');

const recipientId = new mongoose.Types.ObjectId();
const otherRecipientId = new mongoose.Types.ObjectId();
const patientId = new mongoose.Types.ObjectId();
const relatedId = new mongoose.Types.ObjectId();
const originals = { userFindById: User.findById, create: Notification.create, findById: Notification.findById, find: Notification.find, findOne: Notification.findOne, update: Notification.findOneAndUpdate };
let records;
let listFilter;

function accountQuery(id) {
  return { select() { return this; }, lean: async () => ({ _id: id, isActive: true }) };
}

function installMocks() {
  records = new Map();
  listFilter = undefined;
  User.findById = (id) => accountQuery(new mongoose.Types.ObjectId(String(id)));
  Notification.create = async (input) => {
    const id = String(input._id);
    if (records.has(id)) throw Object.assign(new Error('duplicate'), { code: 11000 });
    const record = { ...input, createdAt: new Date('2026-10-01T00:00:00Z'), isRead: false };
    records.set(id, record);
    return record;
  };
  Notification.findById = (id) => ({ lean: async () => records.get(String(id)) || null });
  Notification.findOne = (filter) => ({ select() { return this; }, lean: async () => {
    const record = records.get(String(filter._id));
    return record && String(record.recipient) === String(filter.recipient) ? record : null;
  } });
  Notification.find = (filter) => {
    listFilter = filter;
    let result = [...records.values()].filter((entry) => String(entry.recipient) === String(filter.recipient) &&
      (filter.isRead === undefined || entry.isRead === filter.isRead));
    return {
      select() { return this; }, sort() { return this; }, skip() { return this; },
      limit(value) { result = result.slice(0, value); return this; },
      lean: async () => result
    };
  };
  Notification.findOneAndUpdate = (filter, update) => ({
    lean: async () => {
      const record = records.get(String(filter._id));
      if (!record || String(record.recipient) !== String(filter.recipient) || record.isRead) return null;
      record.isRead = true;
      record.readAt = new Date('2026-10-02T00:00:00Z');
      Object.assign(record, update.$set);
      return record;
    }
  });
}

test.beforeEach(installMocks);
test.after(() => {
  User.findById = originals.userFindById;
  Notification.create = originals.create;
  Notification.findById = originals.findById;
  Notification.find = originals.find;
  Notification.findOne = originals.findOne;
  Notification.findOneAndUpdate = originals.update;
});

test('notification delivery uses durable deterministic IDs and safely recovers duplicate retries', async () => {
  const input = {
    recipient: recipientId, patient: patientId, type: 'lab_result_ready', title: 'Results ready',
    message: 'Results are ready to review.', relatedModel: 'LabOrder', relatedId,
    eventKey: `lab-order:${relatedId}:results-ready`
  };
  const first = await createNotificationOnce(input);
  const replay = await createNotificationOnce(input);
  assert.equal(first.id, replay.id);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(records.size, 1);
});

test('notification inbox and read operation are scoped to the authenticated recipient', async () => {
  await createNotificationOnce({
    recipient: recipientId, patient: patientId, type: 'general', title: 'Private', message: 'Private notice',
    eventKey: 'private-notification-test'
  });
  const list = await listMyNotifications({ page: '1', limit: '10', unreadOnly: 'true' }, { id: recipientId });
  assert.equal(list.notifications.length, 1);
  assert.equal(String(listFilter.recipient), String(recipientId));
  assert.equal(listFilter.isRead, false);
  assert.equal(Object.hasOwn(list.notifications[0], 'recipient'), false);
  const id = list.notifications[0].id;
  const read = await markMyNotificationRead(id, { id: recipientId });
  assert.equal(read.isRead, true);
  await assert.rejects(markMyNotificationRead(id, { id: otherRecipientId }), (error) => error.status === 404);
});

test('notification inputs and pagination reject spoofing, unsupported types, and unsafe values', async () => {
  await assert.rejects(createNotificationOnce({ recipient: recipientId, type: 'general', title: 'x', message: 'y', eventKey: 'valid-key-123', actorId: otherRecipientId }));
  await assert.rejects(createNotificationOnce({ recipient: recipientId, type: 'payment_update', title: 'x', message: 'y', eventKey: 'valid-key-124' }));
  await assert.rejects(listMyNotifications({ limit: '1000' }, { id: recipientId }));
  await assert.rejects(listMyNotifications({ recipient: otherRecipientId }, { id: recipientId }));
});

test('notification API uses authentication and exposes recipient-scoped list/read routes only', () => {
  const router = require('../routes/notification.routes');
  const routes = router.stack.filter((layer) => layer.route).map((layer) => ({ path: layer.route.path, stack: layer.route.stack }));
  assert.deepEqual(routes.map((route) => route.path), ['/', '/:id/read']);
  assert.ok(routes.every((route) => route.stack[0].handle.name === 'authenticate'));
});

test('notification schema indexes recipient-scoped inbox pagination', () => {
  assert.equal(Notification.schema.indexes().some(([keys]) =>
    keys.recipient === 1 && keys.createdAt === -1 && keys._id === -1), true);
});

