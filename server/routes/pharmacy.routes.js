const express = require('express');
const pharmacyController = require('../controllers/pharmacy.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { authorize } = require('../middleware/authorize.middleware');

const router = express.Router();

router.get(
  '/inventory/:medicationId',
  authenticate,
  authorize('pharmacist'),
  pharmacyController.getInventory
);
router.post(
  '/inventory/:inventoryId/stock',
  authenticate,
  authorize('pharmacist'),
  pharmacyController.addStock
);
router.post(
  '/prescriptions/:prescriptionId/dispense',
  authenticate,
  authorize('pharmacist'),
  pharmacyController.dispense
);

module.exports = router;
