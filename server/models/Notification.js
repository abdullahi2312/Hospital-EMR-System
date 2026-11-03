const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema(
  {
    recipient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Notification recipient is required'],
      index: true
    },
    patient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Patient',
      index: true
    },
    type: {
      type: String,
      required: [true, 'Notification type is required'],
      enum: {
        values: ['lab_result_ready', 'break_glass_alert', 'medication_unavailable', 'referral_update', 'general'],
        message: 'Type must be a supported notification type'
      },
      index: true
    },
    title: {
      type: String,
      required: [true, 'Notification title is required'],
      trim: true,
      minlength: [1, 'Notification title cannot be empty'],
      maxlength: [200, 'Notification title cannot exceed 200 characters']
    },
    message: {
      type: String,
      required: [true, 'Notification message is required'],
      trim: true,
      minlength: [1, 'Notification message cannot be empty'],
      maxlength: [5000, 'Notification message cannot exceed 5000 characters']
    },
    relatedModel: {
      type: String,
      trim: true,
      maxlength: [100, 'Related model name cannot exceed 100 characters']
    },
    relatedId: {
      type: mongoose.Schema.Types.ObjectId
    },
    isRead: {
      type: Boolean,
      default: false,
      index: true
    },
    readAt: {
      type: Date
    },
    createdAt: {
      type: Date,
      default: Date.now,
      index: true
    }
  },
  {
    timestamps: true
  }
);

notificationSchema.pre('save', function syncReadAt(next) {
  if (this.isNew || this.isModified('isRead')) {
    if (this.isRead) {
      this.readAt = this.readAt || new Date();
    } else {
      this.readAt = undefined;
    }
  }
  next();
});

function syncReadAtInUpdate(next) {
  const update = this.getUpdate();

  if (!update || Array.isArray(update)) {
    return next();
  }

  const isRead = update.$set?.isRead ?? update.isRead;

  if (isRead === true) {
    update.$set = { ...update.$set, readAt: new Date() };
    delete update.readAt;
  } else if (isRead === false) {
    update.$unset = { ...update.$unset, readAt: 1 };
    delete update.readAt;
    if (update.$set) {
      delete update.$set.readAt;
    }
  }

  this.setUpdate(update);
  next();
}

notificationSchema.pre('findOneAndUpdate', syncReadAtInUpdate);
notificationSchema.pre('updateOne', syncReadAtInUpdate);
notificationSchema.pre('updateMany', syncReadAtInUpdate);

const Notification = mongoose.model('Notification', notificationSchema);

module.exports = Notification;
