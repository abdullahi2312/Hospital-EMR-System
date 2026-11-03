const mongoose = require('mongoose');

const referralSchema = new mongoose.Schema(
  {
    patient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Patient',
      required: [true, 'Patient is required'],
      index: true
    },
    encounter: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Encounter',
      required: [true, 'Encounter is required'],
      index: true
    },
    referringDoctor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Referring doctor is required'],
      index: true
    },
    receivingHospital: {
      type: String,
      required: [true, 'Receiving hospital is required'],
      trim: true,
      minlength: [1, 'Receiving hospital cannot be empty'],
      maxlength: [200, 'Receiving hospital cannot exceed 200 characters']
    },
    specialist: {
      type: String,
      trim: true,
      maxlength: [150, 'Specialist cannot exceed 150 characters']
    },
    reason: {
      type: String,
      required: [true, 'Referral reason is required'],
      trim: true,
      minlength: [1, 'Referral reason cannot be empty'],
      maxlength: [2000, 'Referral reason cannot exceed 2000 characters']
    },
    clinicalSummary: {
      type: String,
      trim: true,
      maxlength: [5000, 'Clinical summary cannot exceed 5000 characters']
    },
    status: {
      type: String,
      enum: {
        values: ['pending', 'accepted', 'completed', 'cancelled'],
        message: 'Status must be pending, accepted, completed, or cancelled'
      },
      default: 'pending',
      index: true
    },
    referredAt: {
      type: Date,
      default: Date.now,
      index: true
    }
  },
  {
    timestamps: true
  }
);

const Referral = mongoose.model('Referral', referralSchema);

module.exports = Referral;
