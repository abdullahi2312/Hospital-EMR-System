'use strict';

const mongoose = require('mongoose');
const { getFhirResource } = require('../services/fhir.service');

const RESOURCE_PATHS = new Set(['Patient', 'Encounter', 'Observation', 'MedicationRequest']);

function issueCode(status) {
  if (status === 400) return 'invalid';
  if (status === 401) return 'security';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  return 'processing';
}

function outcome(res, status, message) {
  return res.type('application/fhir+json').status(status).json({
    resourceType: 'OperationOutcome',
    issue: [{ severity: 'error', code: issueCode(status), diagnostics: message }]
  });
}

function controllerFor(resourceType) {
  return async function readResource(req, res, next) {
    if (!RESOURCE_PATHS.has(resourceType)) return outcome(res, 404, 'FHIR resource type is not supported');
    if (!mongoose.isObjectIdOrHexString(req.params.id)) return outcome(res, 400, 'A valid resource ID is required');
    if (Object.keys(req.query || {}).length > 0) return outcome(res, 400, 'Query parameters are not supported for this resource read');
    if (req.body && (typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length > 0)) {
      return outcome(res, 400, 'Request body is not supported for this read-only endpoint');
    }

    try {
      const resource = await getFhirResource(resourceType, req.params.id, req.user);
      return res.type('application/fhir+json').status(200).json(resource);
    } catch (error) {
      if (error.name === 'FhirServiceError') {
        const status = Number(error.status || error.statusCode) || 500;
        const message = status >= 500
          ? (status === 503 ? 'FHIR resource access is temporarily unavailable' : 'Unable to retrieve FHIR resource')
          : error.message;
        return outcome(res, status, message);
      }
      return next(error);
    }
  };
}

module.exports = {
  getPatient: controllerFor('Patient'),
  getEncounter: controllerFor('Encounter'),
  getObservation: controllerFor('Observation'),
  getMedicationRequest: controllerFor('MedicationRequest')
};
