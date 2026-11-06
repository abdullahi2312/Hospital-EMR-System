const { listAccessLogs } = require('../services/access-log-review.service');

const ALLOWED_QUERY_FIELDS = new Set(['page', 'limit', 'patientId', 'actorId', 'fromDate', 'toDate']);

async function list(req, res) {
  if (Object.keys(req.query || {}).some((field) => !ALLOWED_QUERY_FIELDS.has(field))) {
    return res.status(400).json({ success: false, message: 'Unsupported access-log filter', data: null });
  }

  try {
    const data = await listAccessLogs(req.query || {});
    return res.status(200).json({
      success: true,
      message: 'Access logs retrieved successfully',
      data
    });
  } catch (error) {
    const status = Number(error.status) || 500;
    return res.status(status).json({
      success: false,
      message: status >= 500 ? 'Unable to retrieve access logs' : error.message,
      data: null
    });
  }
}

module.exports = { list };
