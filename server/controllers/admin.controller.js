const { reviewBreakGlassAuthorization } = require('../services/break-glass-review.service');

const REVIEW_DECISIONS = ['justified', 'not_justified'];
const ALLOWED_BODY_FIELDS = new Set(['decision', 'notes']);

function badRequest(res, message) {
  return res.status(400).json({
    success: false,
    message,
    data: null
  });
}

async function reviewBreakGlass(req, res, next) {
  const body = req.body;

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return badRequest(res, 'Request body must be an object');
  }

  if (Object.keys(body).some((field) => !ALLOWED_BODY_FIELDS.has(field))) {
    return badRequest(res, 'Only decision and notes may be provided');
  }

  if (!REVIEW_DECISIONS.includes(body.decision)) {
    return badRequest(res, 'Decision must be justified or not_justified');
  }

  if (
    body.notes !== undefined &&
    body.notes !== null &&
    (typeof body.notes !== 'string' || body.notes.trim().length > 2000)
  ) {
    return badRequest(res, 'Notes must be text no longer than 2000 characters');
  }

  try {
    const review = await reviewBreakGlassAuthorization(
      req.user,
      req.params.id,
      body.decision,
      body.notes
    );

    return res.status(200).json({
      success: true,
      message: 'BreakGlass authorization reviewed successfully',
      data: review
    });
  } catch (error) {
    if (error.name === 'BreakGlassReviewAuditError') {
      return res.status(500).json({
        success: false,
        message: 'Review may have been saved, but audit logging failed. Check the review status before retrying.',
        data: null
      });
    }

    return next(error);
  }
}

module.exports = {
  reviewBreakGlass
};
