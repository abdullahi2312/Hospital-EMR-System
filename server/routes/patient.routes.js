const express = require('express');
const patientController = require('../controllers/patient.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { authorize } = require('../middleware/authorize.middleware');

const router = express.Router();

router.get(
  '/',
  authenticate,
  authorize('receptionist', 'admin'),
  patientController.list
);

router.get(
  '/:id',
  authenticate,
  authorize('receptionist', 'admin', 'patient'),
  patientController.getDetails
);

router.post(
  '/',
  authenticate,
  authorize('receptionist', 'admin'),
  patientController.register
);

module.exports = router;
