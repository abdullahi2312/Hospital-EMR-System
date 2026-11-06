'use strict';

const { listMyNotifications, markMyNotificationRead } = require('../services/notification.service');
const { localizeNotification } = require('../utils/i18n');

async function list(req, res, next) {
  try {
    const data = await listMyNotifications(req.query || {}, req.user);
    data.notifications = data.notifications.map((notification) => localizeNotification(notification, req.language));
    return res.status(200).json({ success: true, message: 'Notifications retrieved successfully', data });
  } catch (error) {
    if (error.status && error.status < 500) return res.status(error.status).json({ success: false, message: error.message, data: null });
    return next(error);
  }
}

async function markRead(req, res, next) {
  const body = req.body === undefined ? {} : req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length > 0) {
    return res.status(400).json({ success: false, message: 'Notification read requests do not accept body fields', data: null });
  }
  try {
    const data = localizeNotification(await markMyNotificationRead(req.params.id, req.user), req.language);
    return res.status(200).json({ success: true, message: 'Notification marked as read', data });
  } catch (error) {
    if (error.status && error.status < 500) return res.status(error.status).json({ success: false, message: error.message, data: null });
    return next(error);
  }
}

module.exports = { list, markRead };
