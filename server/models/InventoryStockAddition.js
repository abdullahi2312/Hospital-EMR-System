const mongoose = require('mongoose');

const inventoryStockAdditionSchema = new mongoose.Schema(
  {
    actor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true
    },
    idempotencyKeyHash: {
      type: String,
      required: true,
      immutable: true,
      select: false,
      match: /^[a-f0-9]{64}$/
    },
    inputFingerprint: {
      type: String,
      required: true,
      immutable: true,
      select: false,
      match: /^[a-f0-9]{64}$/
    },
    legacyOperationHash: {
      type: String,
      required: true,
      immutable: true,
      select: false,
      match: /^[a-f0-9]{64}$/
    },
    inventory: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Inventory',
      required: true,
      immutable: true
    },
    quantity: {
      type: Number,
      required: true,
      min: [Number.MIN_VALUE, 'Stock addition quantity must be positive'],
      immutable: true
    },
    status: {
      type: String,
      enum: ['pending', 'applied'],
      default: 'pending'
    },
    auditCompleted: {
      type: Boolean,
      default: false
    },
    legacyAuditPresent: {
      type: Boolean,
      default: false,
      immutable: true
    }
  },
  { timestamps: true, strict: 'throw' }
);

inventoryStockAdditionSchema.index(
  { actor: 1, idempotencyKeyHash: 1 },
  { unique: true, name: 'unique_inventory_stock_addition_per_actor_key' }
);

const InventoryStockAddition = mongoose.model('InventoryStockAddition', inventoryStockAdditionSchema);

module.exports = InventoryStockAddition;
