'use strict';

const { listAuditLogs } = require('../services/audit-log-review.service');

const ALLOWED_QUERY_FIELDS = new Set([
  'page', 'limit', 'actorId', 'action', 'entityType', 'entityId', 'fromDate', 'toDate'
]);

async function list(req, res) {
  if (Object.keys(req.query || {}).some((field) => !ALLOWED_QUERY_FIELDS.has(field))) {
    return res.status(400).json({ success: false, message: 'Unsupported audit-log filter', data: null });
  }

  try {
    const data = await listAuditLogs(req.query || {});
    return res.status(200).json({ success: true, message: 'Audit logs retrieved successfully', data });
  } catch (error) {
    const status = Number(error.status) || 500;
    return res.status(status).json({
      success: false,
      message: status >= 500 ? 'Unable to retrieve audit logs' : error.message,
      data: null
    });
  }
}

module.exports = { list };
