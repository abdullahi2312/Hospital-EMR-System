'use strict';

const express = require('express');
const notificationController = require('../controllers/notification.controller');
const { authenticate } = require('../middleware/auth.middleware');

const router = express.Router();
router.get('/', authenticate, notificationController.list);
router.patch('/:id/read', authenticate, notificationController.markRead);

module.exports = router;
