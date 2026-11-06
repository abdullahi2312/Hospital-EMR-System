const express = require('express');
const encounterController = require('../controllers/encounter.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { authorize } = require('../middleware/authorize.middleware');

const router = express.Router();

router.post(
  '/',
  authenticate,
  authorize('receptionist', 'admin'),
  encounterController.create
);

router.patch(
  '/:id/assign',
  authenticate,
  authorize('admin'),
  encounterController.assign
);

router.get('/', authenticate, encounterController.list);
router.get('/:id', authenticate, encounterController.details);

router.patch(
  '/:id/close',
  authenticate,
  authorize('doctor'),
  encounterController.close
);

module.exports = router;
