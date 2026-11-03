const express = require('express');

const router = express.Router();

router.get('/health', (_req, res) => {
  res.status(200).json({
    success: true,
    message: 'Hospital EMR API is running',
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
