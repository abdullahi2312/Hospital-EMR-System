const BreakGlass = require('../models/BreakGlass');

function createServiceError() {
  const error = new Error('Unable to expire BreakGlass authorizations');
  error.name = 'BreakGlassExpirationServiceError';
  error.status = 500;
  error.statusCode = 500;
  return error;
}

async function expireBreakGlassAuthorizations() {
  const currentTime = new Date();

  try {
    const result = await BreakGlass.updateMany(
      {
        status: 'active',
        expiresAt: { $lte: currentTime },
        reviewedBy: null,
        reviewedAt: null,
        reviewNotes: null
      },
      { $set: { status: 'expired' } },
      { runValidators: true }
    );

    return { expiredCount: result.modifiedCount };
  } catch (_) {
    throw createServiceError();
  }
}

module.exports = {
  expireBreakGlassAuthorizations
};
