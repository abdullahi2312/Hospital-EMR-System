'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const mongoose = require('mongoose');

const actualInventory = require('../models/Inventory');
const actualAuditLog = require('../models/AuditLog');
const actualStockAddition = require('../models/InventoryStockAddition');

const pharmacistId = new mongoose.Types.ObjectId();
const medicationId = new mongoose.Types.ObjectId();
const inventoryId = new mongoose.Types.ObjectId();
const inventoryRecords = new Map();
const additionRecords = new Map();
const auditRecords = [];
let auditFailure = false;
let auditWriteCount = 0;

function clone(value) {
  return value ? { ...value, stockAdditionOperations: [...(value.stockAdditionOperations || [])] } : null;
}

function queryFor(value) {
  return {
    select() { return this; },
    lean: async () => value
  };
}

const userModel = {
  findById(id) {
    assert.equal(String(id), String(pharmacistId));
    return { select() { return this; }, lean: async () => ({ _id: pharmacistId, role: 'pharmacist', isActive: true }) };
  }
};

const medicationModel = {
  findById(id) {
    assert.equal(String(id), String(medicationId));
    return { select() { return this; }, lean: async () => ({ _id: medicationId, isActive: true }) };
  }
};

const inventoryModel = {
  findById(id) {
    return {
      select() { return this; },
      lean: async () => clone(inventoryRecords.get(String(id)))
    };
  },
  async updateOne(filter, update) {
    const inventory = inventoryRecords.get(String(filter._id));
    if (!inventory || String(inventory.medication) !== String(filter.medication) ||
        inventory.quantity < filter.quantity.$gte || inventory.expiryDate <= filter.expiryDate.$gt ||
        inventory.stockAdditionOperations.some((operationId) => String(operationId) === String(filter.stockAdditionOperations.$ne))) {
      return { matchedCount: 0 };
    }
    inventory.quantity += update.$inc.quantity;
    inventory.lastUpdatedBy = update.$set.lastUpdatedBy;
    if (!inventory.stockAdditionOperations.some((operationId) => String(operationId) === String(update.$addToSet.stockAdditionOperations))) {
      inventory.stockAdditionOperations.push(update.$addToSet.stockAdditionOperations);
    }
    inventory.updatedAt = new Date();
    return { matchedCount: 1 };
  }
};

class StockAdditionDocument {
  constructor(values) {
    Object.assign(this, values);
    this._id ||= new mongoose.Types.ObjectId();
  }

  async save() {
    const key = `${this.actor}:${this.idempotencyKeyHash}`;
    if (additionRecords.has(key)) {
      const error = new Error('duplicate key');
      error.code = 11000;
      throw error;
    }
    additionRecords.set(key, { ...this });
    return this;
  }

  static findOne(filter) {
    const item = additionRecords.get(`${filter.actor}:${filter.idempotencyKeyHash}`);
    return queryFor(item ? { ...item } : null);
  }

  static async updateOne(filter, update) {
    const item = [...additionRecords.values()].find((record) => String(record._id) === String(filter._id));
    if (!item) return { matchedCount: 0 };
    Object.assign(item, update.$set);
    return { matchedCount: 1 };
  }
}

const auditLogModel = {
  findOne(filter) {
    const found = auditRecords.find((audit) => String(audit.actor) === String(filter.actor) &&
      audit.action === filter.action && audit.entityType === filter.entityType &&
      String(audit.entityId) === String(filter.entityId) &&
      (filter['details.operationHash'] === undefined
        ? audit.details.stockAdditionDeduplicationKey === filter['details.stockAdditionDeduplicationKey']
        : audit.details.operationHash === filter['details.operationHash']));
    return queryFor(found ? { ...found, details: { ...found.details } } : null);
  }
};

function replaceModule(relativePath, exports) {
  const modulePath = require.resolve(relativePath);
  const mockedModule = new Module(modulePath);
  mockedModule.filename = modulePath;
  mockedModule.loaded = true;
  mockedModule.exports = exports;
  require.cache[modulePath] = mockedModule;
}

replaceModule('../models/User', userModel);
replaceModule('../models/Medication', medicationModel);
replaceModule('../models/Inventory', inventoryModel);
replaceModule('../models/InventoryStockAddition', StockAdditionDocument);
replaceModule('../models/AuditLog', auditLogModel);
replaceModule('../services/audit-log.service', {
  async writeAuditLog(event) {
    auditWriteCount += 1;
    if (auditFailure) throw new Error('simulated audit outage');
    const existing = auditRecords.find((record) => record.details.stockAdditionDeduplicationKey === event.details.stockAdditionDeduplicationKey);
    if (existing) {
      const error = new Error('duplicate key');
      error.code = 11000;
      throw error;
    }
    auditRecords.push({
      _id: new mongoose.Types.ObjectId(),
      actor: new mongoose.Types.ObjectId(String(event.actorId)),
      action: event.action,
      entityType: event.entityType,
      entityId: new mongoose.Types.ObjectId(String(event.entityId)),
      details: { ...event.details }
    });
  }
});

const { addInventoryStock } = require('../services/pharmacy.service');

test.beforeEach(() => {
  inventoryRecords.clear();
  additionRecords.clear();
  auditRecords.length = 0;
  auditFailure = false;
  auditWriteCount = 0;
  inventoryRecords.set(String(inventoryId), {
    _id: inventoryId,
    medication: medicationId,
    quantity: 7,
    minimumStock: 2,
    unit: 'bottles',
    batchNumber: 'BATCH-1',
    expiryDate: new Date(Date.now() + 86400000),
    lastUpdatedBy: pharmacistId,
    updatedAt: new Date(),
    stockAdditionOperations: []
  });
});

function input(key, quantity = 5, id = inventoryId) {
  return { inventoryId: String(id), quantity, idempotencyKey: key };
}

const user = { id: String(pharmacistId), role: 'pharmacist' };

test('stock addition requires an idempotency key and first request increments once with one audit', async () => {
  await assert.rejects(addInventoryStock({ inventoryId: String(inventoryId), quantity: 5 }, user), /idempotencyKey/i);
  const result = await addInventoryStock(input('stock-add-key-0001'), user);
  assert.equal(result.quantity, 12);
  assert.equal(result.replayed, false);
  assert.equal(auditRecords.length, 1);
  assert.equal(auditRecords[0].details.quantityAdded, 5);
  assert.equal(auditRecords[0].details.operationHash.length, 64);
  assert.equal(auditRecords[0].details.stockAdditionDeduplicationKey.length, 64);
});

test('same actor and key replays without increment; changed quantity or inventory conflicts', async () => {
  const first = await addInventoryStock(input('stock-add-key-0002'), user);
  const replay = await addInventoryStock(input('stock-add-key-0002'), user);
  assert.equal(first.quantity, 12);
  assert.equal(replay.quantity, 12);
  assert.equal(replay.replayed, true);
  await assert.rejects(addInventoryStock(input('stock-add-key-0002', 6), user), { status: 409 });

  const anotherInventory = new mongoose.Types.ObjectId();
  inventoryRecords.set(String(anotherInventory), {
    ...clone(inventoryRecords.get(String(inventoryId))), _id: anotherInventory, quantity: 3, stockAdditionOperations: []
  });
  await assert.rejects(addInventoryStock(input('stock-add-key-0002', 5, anotherInventory), user), { status: 409 });
  assert.equal(inventoryRecords.get(String(inventoryId)).quantity, 12);
  assert.equal(inventoryRecords.get(String(anotherInventory)).quantity, 3);
  assert.equal(auditRecords.length, 1);
});

test('audit failure leaves a durable replay guard and retry repairs audit without a second increment', async () => {
  auditFailure = true;
  await assert.rejects(addInventoryStock(input('stock-add-key-0003'), user), (error) => {
    assert.equal(error.status, 503);
    assert.equal(error.partialSuccess, true);
    return true;
  });
  assert.equal(inventoryRecords.get(String(inventoryId)).quantity, 12);
  assert.equal(auditRecords.length, 0);

  auditFailure = false;
  const recovered = await addInventoryStock(input('stock-add-key-0003'), user);
  assert.equal(recovered.quantity, 12);
  assert.equal(recovered.replayed, true);
  assert.equal(auditRecords.length, 1);
});

test('concurrent same-key requests apply one increment and create one audit event', async () => {
  const results = await Promise.all([
    addInventoryStock(input('stock-add-key-0004'), user),
    addInventoryStock(input('stock-add-key-0004'), user)
  ]);
  assert.equal(inventoryRecords.get(String(inventoryId)).quantity, 12);
  assert.equal(auditRecords.length, 1, JSON.stringify({ results, additions: [...additionRecords.values()], auditWriteCount }));
  assert.equal(results.filter((result) => result.replayed).length, 1);
});

test('different idempotency keys create separate additions', async () => {
  await addInventoryStock(input('stock-add-key-0005'), user);
  await addInventoryStock(input('stock-add-key-0006', 2), user);
  assert.equal(inventoryRecords.get(String(inventoryId)).quantity, 14);
  assert.equal(auditRecords.length, 2);
});

test('declares durable uniqueness indexes and inventory operation markers', () => {
  const operationIndex = actualStockAddition.schema.indexes().find(([keys]) => keys.actor === 1 && keys.idempotencyKeyHash === 1);
  assert.equal(operationIndex?.[1].unique, true);
  const auditIndex = actualAuditLog.schema.indexes().find(([keys]) => keys['details.stockAdditionDeduplicationKey'] === 1);
  assert.equal(auditIndex?.[1].unique, true);
  assert.ok(actualInventory.schema.path('stockAdditionOperations'));
  const auditValidation = new actualAuditLog({
    actor: pharmacistId,
    action: 'inventory_stock_added',
    entityType: 'Inventory',
    entityId: inventoryId,
    details: {
      quantityAdded: 5,
      operationHash: 'a'.repeat(64),
      stockAdditionDeduplicationKey: 'b'.repeat(64)
    }
  }).validateSync();
  assert.equal(auditValidation, undefined);
});
