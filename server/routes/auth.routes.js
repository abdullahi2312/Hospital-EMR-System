const express = require('express');
const authController = require('../controllers/auth.controller');
const { loginRateLimit } = require('../middleware/login-rate-limit.middleware');

const router = express.Router();

router.post('/login', loginRateLimit, authController.login);
router.post('/patient-login', loginRateLimit, authController.patientLogin);

module.exports = router;
