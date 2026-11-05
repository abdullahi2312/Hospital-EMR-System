'use strict';

const express = require('express');
const { authenticate } = require('../middleware/auth.middleware');
const fhirController = require('../controllers/fhir.controller');

const router = express.Router();

function authenticateFhir(req, res, next) {
  const originalJson = res.json;
  res.json = function fhirAuthenticationResponse(body) {
    const status = this.statusCode;
    this.json = originalJson;
    if (status === 401) {
      this.type('application/fhir+json');
      return originalJson.call(this, {
        resourceType: 'OperationOutcome',
        issue: [{ severity: 'error', code: 'security', diagnostics: 'Authentication required' }]
      });
    }
    return originalJson.call(this, body);
  };

  return authenticate(req, res, (error) => {
    res.json = originalJson;
    next(error);
  });
}

router.get('/Patient/:id', authenticateFhir, fhirController.getPatient);
router.get('/Encounter/:id', authenticateFhir, fhirController.getEncounter);
router.get('/Observation/:id', authenticateFhir, fhirController.getObservation);
router.get('/MedicationRequest/:id', authenticateFhir, fhirController.getMedicationRequest);

router.use((error, _req, res, next) => {
  if (res.headersSent) return next(error);
  const candidateStatus = Number(error.status || error.statusCode);
  const status = Number.isInteger(candidateStatus) && candidateStatus >= 400 && candidateStatus < 600
    ? candidateStatus
    : 500;
  const code = status === 400 ? 'invalid'
    : status === 401 ? 'security'
      : status === 403 ? 'forbidden'
        : status === 404 ? 'not-found'
          : 'processing';
  return res.type('application/fhir+json').status(status).json({
    resourceType: 'OperationOutcome',
    issue: [{
      severity: 'error',
      code,
      diagnostics: status >= 500 ? 'Unable to process FHIR request' : 'FHIR request was not permitted'
    }]
  });
});

module.exports = router;
