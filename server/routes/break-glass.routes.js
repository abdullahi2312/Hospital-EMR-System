const express = require('express');
const controller = require('../controllers/break-glass.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { authorize } = require('../middleware/authorize.middleware');

const router = express.Router();

router.post('/:patientId/break-glass', authenticate, authorize('doctor'), controller.activate);

module.exports = router;
