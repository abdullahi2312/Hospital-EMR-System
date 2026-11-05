'use strict';

const express = require('express');
const paymentController = require('../controllers/payment.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { authorize } = require('../middleware/authorize.middleware');

const router = express.Router();

router.post('/', authenticate, authorize('patient'), paymentController.initiate);
router.get('/', authenticate, authorize('patient'), paymentController.list);
router.get('/:paymentReference/status', authenticate, authorize('patient'), paymentController.getStatus);

module.exports = router;
