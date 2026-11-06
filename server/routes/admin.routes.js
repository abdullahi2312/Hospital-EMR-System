const express = require('express');
const adminController = require('../controllers/admin.controller');
const analyticsController = require('../controllers/analytics.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { authorize } = require('../middleware/authorize.middleware');

const router = express.Router();

router.get('/analytics', authenticate, authorize('admin'), analyticsController.operationalAnalytics);

router.patch(
  '/break-glass/:id/review',
  authenticate,
  authorize('admin'),
  adminController.reviewBreakGlass
);

module.exports = router;
