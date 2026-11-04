const {
  addDiagnosis,
  getEncounterDiagnoses,
  updateEncounterNotes
} = require('../services/diagnosis.service');

const ALLOWED_DIAGNOSIS_FIELDS = new Set([
  'patient',
  'code',
  'description',
  'isPrimary',
  'idempotencyKey'
]);
const ALLOWED_NOTE_FIELDS = new Set([
  'clinicalNotes',
  'examinationFindings',
  'assessment',
  'treatmentPlan',
  'followUpInstructions'
]);

function badRequest(res, message) {
  return res.status(400).json({
    success: false,
    message,
    data: null
  });
}

async function add(req, res, next) {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return badRequest(res, 'Request body must be an object');
  }

  if (Object.keys(body).some((field) => !ALLOWED_DIAGNOSIS_FIELDS.has(field))) {
    return badRequest(res, 'Request contains unsupported or server-managed fields');
  }

  try {
    const diagnosis = await addDiagnosis(
      { ...body, encounter: req.params.encounterId },
      req.user
    );
    return res.status(diagnosis.replayed ? 200 : 201).json({
      success: true,
      message: diagnosis.replayed ? 'Previously recorded diagnosis returned' : 'Diagnosis added successfully',
      data: diagnosis
    });
  } catch (error) {
    if (error.name === 'DiagnosisServiceError' && error.partialSuccess === true) {
      return res.status(error.status || 503).json({
        success: false,
        message: 'Diagnosis may already have been saved, but audit logging did not complete. Retry with the same idempotencyKey to avoid a duplicate.',
        data: {
          partialSuccess: true,
          ...(error.diagnosisId ? { diagnosisId: error.diagnosisId } : {})
        }
      });
    }
    return next(error);
  }
}

async function listForEncounter(req, res, next) {
  try {
    const diagnoses = await getEncounterDiagnoses(req.params.encounterId, req.user);
    return res.status(200).json({
      success: true,
      message: 'Encounter diagnoses retrieved successfully',
      data: { diagnoses }
    });
  } catch (error) {
    return next(error);
  }
}

async function updateNotes(req, res, next) {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return badRequest(res, 'Request body must be an object');
  }
  if (Object.keys(body).length === 0) {
    return badRequest(res, 'Provide at least one clinical note field');
  }
  if (Object.keys(body).some((field) => !ALLOWED_NOTE_FIELDS.has(field))) {
    return badRequest(res, 'Request contains unsupported or server-managed fields');
  }

  try {
    const result = await updateEncounterNotes(
      { ...body, encounter: req.params.encounterId },
      req.user
    );
    return res.status(200).json({
      success: true,
      message: 'Encounter clinical notes updated successfully',
      data: result
    });
  } catch (error) {
    if (error.name === 'DiagnosisServiceError' && error.partialSuccess === true) {
      return res.status(error.status || 503).json({
        success: false,
        message: 'Encounter notes may already have been saved, but audit logging did not complete. Verify the encounter before retrying.',
        data: {
          partialSuccess: true,
          ...(error.encounterId ? { encounterId: error.encounterId } : {})
        }
      });
    }
    return next(error);
  }
}

module.exports = {
  add,
  listForEncounter,
  updateNotes
};
