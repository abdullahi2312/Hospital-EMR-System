const express = require('express');
const labController = require('../controllers/lab.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { authorize } = require('../middleware/authorize.middleware');

const router = express.Router();
const encounterRouter = express.Router();

router.get(
  '/orders/pending',
  authenticate,
  authorize('lab_technician'),
  labController.listPending
);
router.get(
  '/orders/:orderId',
  authenticate,
  authorize('lab_technician'),
  labController.getOrder
);
router.post(
  '/orders/:orderId/results',
  authenticate,
  authorize('lab_technician'),
  labController.createResult
);
router.patch(
  '/orders/:orderId/reject-sample',
  authenticate,
  authorize('lab_technician'),
  labController.rejectSample
);

encounterRouter.post(
  '/:encounterId/lab-orders',
  authenticate,
  authorize('doctor'),
  labController.createOrder
);

module.exports = router;
module.exports.encounterRouter = encounterRouter;
