'use strict';

const express = require('express');
const { authenticate } = require('../middleware/auth.middleware');
const { authorize } = require('../middleware/authorize.middleware');
const controller = require('../controllers/patient-portal.controller');

const router = express.Router();
router.use(authenticate, authorize('patient'));
router.get('/doctors', controller.doctors);
router.get('/profile', controller.profile);
router.get('/lab-results', controller.labResults);
router.get('/prescriptions', controller.prescriptions);
router.get('/summary.pdf', controller.summaryPdf);

module.exports = router;
