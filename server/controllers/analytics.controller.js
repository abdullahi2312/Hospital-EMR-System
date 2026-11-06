'use strict';

const { getOperationalAnalytics } = require('../services/analytics.service');

async function operationalAnalytics(req, res, next) {
  const query = req.query || {};
  if (Object.keys(query).some((key) => !['from', 'to'].includes(key))) {
    return res.status(400).json({ success: false, message: 'Only from and to date filters are supported', data: null });
  }
  try {
    const data = await getOperationalAnalytics(query, req.user);
    return res.status(200).json({ success: true, message: 'Hospital operational analytics retrieved successfully', data });
  } catch (error) {
    if (error.status && error.status < 500) {
      return res.status(error.status).json({ success: false, message: error.message, data: null });
    }
    return next(error);
  }
}

module.exports = { operationalAnalytics };
