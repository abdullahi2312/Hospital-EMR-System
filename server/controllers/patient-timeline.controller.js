const mongoose = require('mongoose');
const { getPatientTimeline } = require('../services/patient-timeline.service');

const SUPPORTED_QUERY_FIELDS = new Set(['page', 'limit', 'from', 'to']);

function badRequest(res, message) {
  return res.status(400).json({ success: false, message, data: null });
}

async function getTimeline(req, res, next) {
  if (!mongoose.isObjectIdOrHexString(req.params.id)) {
    return badRequest(res, 'A valid patient ID is required');
  }

  const query = req.query || {};
  if (Object.keys(query).some((field) => !SUPPORTED_QUERY_FIELDS.has(field))) {
    return badRequest(res, 'Query contains unsupported parameters');
  }
  if (req.body && (typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length > 0)) {
    return badRequest(res, 'Request body is not supported');
  }

  try {
    const timeline = await getPatientTimeline(req.params.id, req.user, {
      ...(query.page !== undefined ? { page: query.page } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.from !== undefined ? { from: query.from } : {}),
      ...(query.to !== undefined ? { to: query.to } : {})
    });
    return res.status(200).json({
      success: true,
      message: 'Patient clinical timeline retrieved successfully',
      data: timeline
    });
  } catch (error) {
    if (error.name === 'PatientTimelineServiceError') {
      const status = Number(error.status || error.statusCode) || 500;
      return res.status(status).json({
        success: false,
        message: status >= 500 ? 'Unable to retrieve patient timeline' : error.message,
        data: null
      });
    }
    return next(error);
  }
}

module.exports = { getTimeline };
