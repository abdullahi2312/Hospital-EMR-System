const express = require('express');
const consentController = require('../controllers/consent.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { authorize } = require('../middleware/authorize.middleware');

const router = express.Router();

router.post('/', authenticate, authorize('patient'), consentController.grant);
router.get('/', authenticate, authorize('patient'), consentController.list);
router.patch('/:consentId/revoke', authenticate, authorize('patient'), consentController.revoke);

module.exports = router;
