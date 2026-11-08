'use strict';

const express = require('express');
const controller = require('../controllers/department.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { authorize } = require('../middleware/authorize.middleware');

const router = express.Router();
router.get('/', authenticate, authorize('receptionist', 'admin'), controller.list);
router.post('/', authenticate, authorize('admin'), controller.create);

module.exports = router;
