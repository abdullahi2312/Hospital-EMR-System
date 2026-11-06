const express = require('express');
const controller = require('../controllers/user-management.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { authorize } = require('../middleware/authorize.middleware');

const router = express.Router();
const adminOnly = [authenticate, authorize('admin')];

router.post('/', ...adminOnly, controller.create);
router.get('/', ...adminOnly, controller.list);
router.get('/:userId', ...adminOnly, controller.details);
router.patch('/:userId/status', ...adminOnly, controller.updateStatus);

module.exports = router;
