const express = require('express');
const User = require('../models/User');
const { authenticate } = require('../middleware/auth.middleware');
const { authorize } = require('../middleware/authorize.middleware');

const router = express.Router();
const USER_ROLES = User.schema.path('role').enumValues;

router.get('/profile', authenticate, authorize(...USER_ROLES), (req, res) => {
  const profile = {
    id: req.user.id,
    fullName: req.user.fullName,
    username: req.user.username,
    role: req.user.role,
    ...(req.user.patient ? { patient: req.user.patient } : {})
  };

  return res.status(200).json({
    success: true,
    message: 'Protected profile retrieved successfully',
    data: profile
  });
});

module.exports = router;
