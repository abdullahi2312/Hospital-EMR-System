const mongoose = require('mongoose');

const inventorySchema = new mongoose.Schema(
  {
    medication: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Medication',
      required: [true, 'Medication is required'],
      index: true
    },
    batchNumber: {
      type: String,
      required: [true, 'Batch number is required'],
      trim: true,
      minlength: [1, 'Batch number cannot be empty'],
      maxlength: [100, 'Batch number cannot exceed 100 characters'],
      index: true
    },
    quantity: {
      type: Number,
      required: [true, 'Quantity is required'],
      default: 0,
      min: [0, 'Quantity cannot be negative'],
      index: true
    },
    minimumStock: {
      type: Number,
      required: [true, 'Minimum stock is required'],
      default: 10,
      min: [0, 'Minimum stock cannot be negative']
    },
    unit: {
      type: String,
      required: [true, 'Unit is required'],
      trim: true,
      minlength: [1, 'Unit cannot be empty'],
      maxlength: [50, 'Unit cannot exceed 50 characters']
    },
    expiryDate: {
      type: Date,
      required: [true, 'Expiry date is required'],
      index: true
    },
    supplier: {
      type: String,
      trim: true,
      maxlength: [200, 'Supplier cannot exceed 200 characters']
    },
    location: {
      type: String,
      trim: true,
      maxlength: [200, 'Location cannot exceed 200 characters']
    },
    lastUpdatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Last updated by user is required']
    }
  },
  {
    timestamps: true
  }
);

inventorySchema.index(
  { medication: 1, batchNumber: 1 },
  { unique: true, name: 'unique_batch_per_medication' }
);

const Inventory = mongoose.model('Inventory', inventorySchema);

module.exports = Inventory;
