const { recordVitals, getEncounterVitals } = require('../services/vital.service');

const ALLOWED_VITAL_FIELDS = new Set([
  'patient',
  'bloodPressure',
  'temperature',
  'pulse',
  'weight',
  'height',
  'oxygenSaturation',
  'idempotencyKey'
]);

function badRequest(res, message) {
  return res.status(400).json({
    success: false,
    message,
    data: null
  });
}

async function record(req, res, next) {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return badRequest(res, 'Request body must be an object');
  }

  if (Object.keys(body).some((field) => !ALLOWED_VITAL_FIELDS.has(field))) {
    return badRequest(res, 'Request contains unsupported or server-managed fields');
  }

  if (
    body.bloodPressure &&
    (typeof body.bloodPressure !== 'object' ||
      Array.isArray(body.bloodPressure) ||
      Object.keys(body.bloodPressure).some((field) => !['systolic', 'diastolic'].includes(field)))
  ) {
    return badRequest(res, 'Blood pressure may contain only systolic and diastolic values');
  }

  try {
    const vital = await recordVitals(
      { ...body, encounter: req.params.encounterId },
      req.user
    );

    return res.status(201).json({
      success: true,
      message: vital.replayed ? 'Previously recorded vital submission returned' : 'Vital signs recorded successfully',
      data: vital
    });
  } catch (error) {
    if (error.name === 'VitalServiceError' && error.partialSuccess === true) {
      return res.status(error.status || 503).json({
        success: false,
        message: 'Vital was saved, but audit logging did not complete. Retry with the same idempotencyKey to avoid a duplicate.',
        data: {
          partialSuccess: true,
          ...(error.vitalId ? { vitalId: error.vitalId } : {})
        }
      });
    }
    return next(error);
  }
}

async function listForEncounter(req, res, next) {
  try {
    const vitals = await getEncounterVitals(req.params.encounterId, req.user);
    return res.status(200).json({
      success: true,
      message: 'Encounter vitals retrieved successfully',
      data: { vitals }
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  record,
  listForEncounter
};
