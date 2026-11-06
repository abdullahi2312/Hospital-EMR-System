const express = require('express');
const controller = require('../controllers/access-log.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { authorize } = require('../middleware/authorize.middleware');

const router = express.Router();

router.get('/', authenticate, authorize('admin'), controller.list);

module.exports = router;
