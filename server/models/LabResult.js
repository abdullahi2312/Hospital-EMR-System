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
    // Optional for compatibility with historical single-result documents.
    componentId: {
      type: String,
      trim: true,
      lowercase: true,
      minlength: [1, 'Component ID cannot be empty'],
      maxlength: [80, 'Component ID cannot exceed 80 characters'],
      match: [/^[a-z0-9][a-z0-9._-]*$/, 'Component ID format is invalid']
    },
    componentName: {
      type: String,
      trim: true,
      minlength: [1, 'Component name cannot be empty'],
      maxlength: [200, 'Component name cannot exceed 200 characters']
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

labResultSchema.index(
  { labOrder: 1, componentId: 1 },
  {
    unique: true,
    partialFilterExpression: { componentId: { $type: 'string' } },
    name: 'unique_lab_order_component_result'
  }
);

// Supports bounded admin laboratory-result analytics filtered by result date.
labResultSchema.index({ resultedAt: 1 }, { name: 'lab_result_analytics_date' });

const LabResult = mongoose.model('LabResult', labResultSchema);

module.exports = LabResult;
