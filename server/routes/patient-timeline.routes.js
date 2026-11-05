const express = require('express');
const patientTimelineController = require('../controllers/patient-timeline.controller');
const { authenticate } = require('../middleware/auth.middleware');

const router = express.Router();

router.get('/:id/timeline', authenticate, patientTimelineController.getTimeline);

module.exports = router;
