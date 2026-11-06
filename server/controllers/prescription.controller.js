const { createPrescription } = require('../services/prescription.service');

const ALLOWED_FIELDS = new Set([
  'medicationId',
  'dose',
  'route',
  'frequency',
  'duration',
  'quantity',
  'instructions',
  'idempotencyKey',
  'overrideAllergyWarning',
  'allergyOverrideReason'
]);

function badRequest(res, message) {
  return res.status(400).json({
    success: false,
    message,
    data: null
  });
}

async function create(req, res, next) {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return badRequest(res, 'Request body must be an object');
  }
  if (Object.keys(body).some((field) => !ALLOWED_FIELDS.has(field))) {
    return badRequest(res, 'Request contains unsupported or server-managed fields');
  }
  if (body.overrideAllergyWarning !== undefined && typeof body.overrideAllergyWarning !== 'boolean') {
    return badRequest(res, 'overrideAllergyWarning must be a boolean');
  }
  if (body.overrideAllergyWarning === true && (
    typeof body.allergyOverrideReason !== 'string' ||
    body.allergyOverrideReason.trim().length < 20 ||
    body.allergyOverrideReason.trim().length > 1000
  )) {
    return badRequest(res, 'Allergy override reason must contain 20 to 1000 trimmed characters');
  }
  if (body.overrideAllergyWarning !== true && body.allergyOverrideReason !== undefined) {
    return badRequest(res, 'An allergy override reason requires overrideAllergyWarning to be true');
  }

  try {
    const prescription = await createPrescription(
      { ...body, encounter: req.params.encounterId },
      req.user
    );
    return res.status(prescription.replayed ? 200 : 201).json({
      success: true,
      message: prescription.replayed
        ? 'Previously created prescription returned'
        : 'Prescription created successfully',
      data: prescription
    });
  } catch (error) {
    if (error.allergyWarning === true) {
      return res.status(409).json({
        success: false,
        message: error.message || 'Possible allergy match found; prescription was blocked',
        data: { allergyWarning: true }
      });
    }

    if (error.name === 'PrescriptionServiceError' && error.partialSuccess === true) {
      return res.status(error.status || 503).json({
        success: false,
        message: 'Prescription may already have been saved, but audit logging did not complete. Retry with the same idempotencyKey to avoid a duplicate.',
        data: {
          partialSuccess: true,
          ...(error.prescriptionId ? { prescriptionId: error.prescriptionId } : {})
        }
      });
    }

    return next(error);
  }
}

module.exports = { create };
