const mongoose = require('mongoose');

const referenceRangeSchema = new mongoose.Schema(
  {
    minimum: Number,
    maximum: Number
  },
  { _id: false }
);

referenceRangeSchema.pre('validate', function validateReferenceRange(next) {
  if (
    this.minimum != null &&
    this.maximum != null &&
    this.minimum > this.maximum
  ) {
    this.invalidate('minimum', 'Reference range minimum cannot exceed maximum');
  }
  next();
});

const labResultSchema = new mongoose.Schema(
  {
    labOrder: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'LabOrder',
      required: [true, 'Lab order is required'],
      index: true
    },
    patient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Patient',
      required: [true, 'Patient is required'],
      index: true
    },
    technician: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Technician is required'],
      index: true
    },
    resultType: {
      type: String,
      required: [true, 'Result type is required'],
      enum: {
        values: ['numeric', 'text'],
        message: 'Result type must be numeric or text'
      }
    },
    numericValue: {
      type: Number,
      required: [
        function requireNumericValue() {
          return this.resultType === 'numeric';
        },
        'Numeric value is required for numeric results'
      ]
    },
    textValue: {
      type: String,
      required: [
        function requireTextValue() {
          return this.resultType === 'text';
        },
        'Text value is required for text results'
      ],
      trim: true,
      maxlength: [2000, 'Text result cannot exceed 2000 characters']
    },
    unit: {
      type: String,
      trim: true,
      maxlength: [50, 'Unit cannot exceed 50 characters']
    },
    referenceRange: {
      type: referenceRangeSchema
    },
    flag: {
      type: String,
      enum: {
        values: ['normal', 'high', 'low', 'unclassified'],
        message: 'Flag must be normal, high, low, or unclassified'
      },
      default: 'unclassified',
      index: true
    },
    notes: {
      type: String,
      trim: true,
      maxlength: [2000, 'Notes cannot exceed 2000 characters']
    },
    resultedAt: {
      type: Date,
      default: Date.now
    }
  },
  {
    timestamps: true
  }
);

const LabResult = mongoose.model('LabResult', labResultSchema);

module.exports = LabResult;
