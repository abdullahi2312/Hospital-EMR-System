const mongoose = require('mongoose');

const allergySchema = new mongoose.Schema(
  {
    patient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Patient',
      required: [true, 'Patient is required'],
      index: true
    },
    allergen: {
      type: String,
      required: [true, 'Allergen is required'],
      trim: true,
      minlength: [1, 'Allergen cannot be empty'],
      maxlength: [150, 'Allergen cannot exceed 150 characters'],
      index: true
    },
    allergenGroup: {
      type: String,
      trim: true,
      maxlength: [100, 'Allergen group cannot exceed 100 characters'],
      index: true
    },
    reaction: {
      type: String,
      required: [true, 'Reaction is required'],
      trim: true,
      minlength: [1, 'Reaction cannot be empty'],
      maxlength: [1000, 'Reaction cannot exceed 1000 characters']
    },
    severity: {
      type: String,
      required: [true, 'Severity is required'],
      enum: {
        values: ['mild', 'moderate', 'severe'],
        message: 'Severity must be mild, moderate, or severe'
      }
    },
    status: {
      type: String,
      enum: {
        values: ['active', 'resolved'],
        message: 'Status must be active or resolved'
      },
      default: 'active',
      index: true
    },
    recordedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Recording user is required']
    },
    notes: {
      type: String,
      trim: true,
      maxlength: [2000, 'Notes cannot exceed 2000 characters']
    },
    recordedAt: {
      type: Date,
      default: Date.now
    }
  },
  {
    timestamps: true
  }
);

const Allergy = mongoose.model('Allergy', allergySchema);

module.exports = Allergy;
