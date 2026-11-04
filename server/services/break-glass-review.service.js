const mongoose = require('mongoose');
const User = require('../models/User');
const BreakGlass = require('../models/BreakGlass');
const { writeAuditLog } = require('./audit-log.service');

function createServiceError(message, status) {
  const error = new Error(message);
  error.name = 'BreakGlassReviewServiceError';
  error.status = status;
  error.statusCode = status;
  return error;
}

function validateReviewNotes(reviewNotes) {
  if (reviewNotes === undefined || reviewNotes === null) {
    return undefined;
  }

  if (typeof reviewNotes !== 'string') {
    throw createServiceError('Review notes must be text', 400);
  }

  const trimmedNotes = reviewNotes.trim();
  if (trimmedNotes.length > 2000) {
    throw createServiceError('Review notes cannot exceed 2000 characters', 400);
  }

  return trimmedNotes || undefined;
}

function toSafeReviewResult(record) {
  return {
    id: record._id.toString(),
    patient: record.patient.toString(),
    doctor: record.doctor.toString(),
    status: record.status,
    activatedAt: record.activatedAt,
    expiresAt: record.expiresAt,
    reviewedBy: record.reviewedBy.toString(),
    reviewedAt: record.reviewedAt,
    ...(record.reviewNotes ? { reviewNotes: record.reviewNotes } : {})
  };
}

async function reviewBreakGlassAuthorization(adminUser, breakGlassId, reviewDecision, reviewNotes) {
  if (!adminUser || typeof adminUser !== 'object' || !mongoose.isObjectIdOrHexString(adminUser.id)) {
    throw createServiceError('Authentication required', 401);
  }

  if (!mongoose.isObjectIdOrHexString(breakGlassId)) {
    throw createServiceError('A valid BreakGlass record ID is required', 400);
  }

  if (!['justified', 'not_justified'].includes(reviewDecision)) {
    throw createServiceError('Review decision must be justified or not_justified', 400);
  }

  const trimmedNotes = validateReviewNotes(reviewNotes);
  const adminId = String(adminUser.id);

  let admin;
  try {
    admin = await User.findById(adminId)
      .select('_id role isActive')
      .lean();
  } catch (_) {
    throw createServiceError('Unable to verify administrator authorization', 500);
  }

  if (!admin) {
    throw createServiceError('Authentication required', 401);
  }

  if (admin.role !== 'admin' || admin.isActive !== true) {
    throw createServiceError('Only active administrators may review BreakGlass records', 403);
  }

  const normalizedBreakGlassId = String(breakGlassId);
  let record;
  try {
    record = await BreakGlass.findById(normalizedBreakGlassId)
      .select('_id patient doctor status activatedAt expiresAt reviewedBy reviewedAt reviewNotes')
      .lean();
  } catch (_) {
    throw createServiceError('Unable to retrieve BreakGlass record', 500);
  }

  if (!record) {
    throw createServiceError('BreakGlass record not found', 404);
  }

  if (String(record.doctor) === String(admin._id)) {
    throw createServiceError('Users cannot review their own emergency authorization', 403);
  }

  if (
    record.reviewedBy ||
    record.reviewedAt ||
    ['justified', 'not_justified'].includes(record.status)
  ) {
    throw createServiceError('BreakGlass record has already been reviewed', 409);
  }

  const reviewedAt = new Date();
  const update = {
    $set: {
      status: reviewDecision,
      reviewedBy: admin._id,
      reviewedAt
    }
  };

  if (trimmedNotes) {
    update.$set.reviewNotes = trimmedNotes;
  } else {
    update.$unset = { reviewNotes: 1 };
  }

  let reviewedRecord;
  try {
    reviewedRecord = await BreakGlass.findOneAndUpdate(
      {
        _id: normalizedBreakGlassId,
        reviewedBy: { $exists: false },
        reviewedAt: { $exists: false },
        status: { $nin: ['justified', 'not_justified'] }
      },
      update,
      { new: true, runValidators: true }
    );
  } catch (_) {
    throw createServiceError('Unable to review BreakGlass record', 500);
  }

  if (!reviewedRecord) {
    throw createServiceError('BreakGlass record has already been reviewed or changed', 409);
  }

  try {
    await writeAuditLog({
      actorId: admin._id,
      action: 'break_glass_reviewed',
      entityType: 'BreakGlass',
      entityId: reviewedRecord._id,
      details: { decision: reviewDecision }
    });
  } catch (_) {
    const error = createServiceError(
      'BreakGlass review was saved, but audit logging failed. Check the review status before retrying.',
      500
    );
    error.name = 'BreakGlassReviewAuditError';
    error.reviewSaved = true;
    error.auditWritten = false;
    error.entityId = reviewedRecord._id.toString();
    throw error;
  }

  return toSafeReviewResult(reviewedRecord);
}

module.exports = {
  reviewBreakGlassAuthorization
};
