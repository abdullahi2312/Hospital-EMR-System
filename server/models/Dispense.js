const mongoose = require('mongoose');

const dispenseSchema = new mongoose.Schema(
  {
    prescription: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Prescription',
      required: [true, 'Prescription is required'],
      index: true
    },
    patient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Patient',
      required: [true, 'Patient is required'],
      index: true
    },
    medication: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Medication',
      required: [true, 'Medication is required'],
      index: true
    },
    inventory: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Inventory',
      required: [true, 'Inventory batch is required'],
      index: true
    },
    pharmacist: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Pharmacist is required'],
      index: true
    },
    quantityDispensed: {
      type: Number,
      required: [true, 'Dispensed quantity is required'],
      validate: {
        validator: (value) => value > 0,
        message: 'Dispensed quantity must be greater than zero'
      }
    },
    unit: {
      type: String,
      required: [true, 'Unit is required'],
      trim: true,
      minlength: [1, 'Unit cannot be empty'],
      maxlength: [50, 'Unit cannot exceed 50 characters']
    },
    notes: {
      type: String,
      trim: true,
      maxlength: [2000, 'Notes cannot exceed 2000 characters']
    },
    dispensedAt: {
      type: Date,
      default: Date.now,
      index: true
    }
  },
  {
    timestamps: true
  }
);

const Dispense = mongoose.model('Dispense', dispenseSchema);

module.exports = Dispense;
