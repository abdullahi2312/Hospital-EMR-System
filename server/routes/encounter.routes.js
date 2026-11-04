const express = require('express');
const vitalController = require('../controllers/vital.controller');
const diagnosisController = require('../controllers/diagnosis.controller');
const prescriptionController = require('../controllers/prescription.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { authorize } = require('../middleware/authorize.middleware');

const router = express.Router();

router.route('/:encounterId/vitals')
  .post(authenticate, authorize('doctor'), vitalController.record)
  .get(authenticate, authorize('doctor'), vitalController.listForEncounter);

router.route('/:encounterId/diagnoses')
  .post(authenticate, authorize('doctor'), diagnosisController.add)
  .get(authenticate, authorize('doctor'), diagnosisController.listForEncounter);

router.post(
  '/:encounterId/prescriptions',
  authenticate,
  authorize('doctor'),
  prescriptionController.create
);

router.patch(
  '/:encounterId/notes',
  authenticate,
  authorize('doctor'),
  diagnosisController.updateNotes
);

module.exports = router;
