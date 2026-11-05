const express = require('express');
const referralController = require('../controllers/referral.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { authorize } = require('../middleware/authorize.middleware');

const router = express.Router();

router.post('/', authenticate, authorize('doctor'), referralController.create);
router.get('/', authenticate, referralController.list);
router.get('/:id', authenticate, referralController.details);
router.patch('/:id/status', authenticate, referralController.updateStatus);

module.exports = router;
