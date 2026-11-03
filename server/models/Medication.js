const mongoose = require('mongoose');

const medicationSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Medication name is required'],
      trim: true,
      lowercase: true,
      minlength: [1, 'Medication name cannot be empty'],
      maxlength: [200, 'Medication name cannot exceed 200 characters'],
      index: true
    },
    genericName: {
      type: String,
      trim: true,
      lowercase: true,
      maxlength: [200, 'Generic name cannot exceed 200 characters'],
      index: true
    },
    brandName: {
      type: String,
      trim: true,
      lowercase: true,
      maxlength: [200, 'Brand name cannot exceed 200 characters']
    },
    category: {
      type: String,
      required: [true, 'Medication category is required'],
      trim: true,
      minlength: [1, 'Medication category cannot be empty'],
      maxlength: [100, 'Medication category cannot exceed 100 characters'],
      index: true
    },
    strength: {
      type: String,
      required: [true, 'Medication strength is required'],
      trim: true,
      minlength: [1, 'Medication strength cannot be empty'],
      maxlength: [100, 'Medication strength cannot exceed 100 characters']
    },
    dosageForm: {
      type: String,
      required: [true, 'Dosage form is required'],
      enum: {
        values: ['tablet', 'capsule', 'syrup', 'injection', 'cream', 'drops', 'inhaler', 'other'],
        message: 'Dosage form must be tablet, capsule, syrup, injection, cream, drops, inhaler, or other'
      }
    },
    route: {
      type: String,
      required: [true, 'Medication route is required'],
      enum: {
        values: ['oral', 'injection', 'topical', 'inhalation', 'other'],
        message: 'Route must be oral, injection, topical, inhalation, or other'
      }
    },
    description: {
      type: String,
      trim: true,
      maxlength: [2000, 'Description cannot exceed 2000 characters']
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Creating user is required']
    }
  },
  {
    timestamps: true
  }
);

const Medication = mongoose.model('Medication', medicationSchema);

module.exports = Medication;
