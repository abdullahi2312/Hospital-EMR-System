const {
  registerPatient,
  listPatients,
  getPatientDetails
} = require('../services/patient.service');

const ALLOWED_PATIENT_FIELDS = new Set([
  'firstName',
  'fatherName',
  'grandfatherName',
  'dateOfBirth',
  'estimatedAge',
  'sex',
  'gender',
  'phone',
  'district',
  'emergencyContact',
  'allergies',
  'allergyStatus',
  'idempotencyKey'
]);

const SAFE_REGISTRATION_ERROR_CODES = new Set([
  'PATIENT_IDEMPOTENCY_NOT_CONFIGURED',
  'PATIENT_REGISTRATION_IN_PROGRESS',
  'PATIENT_REGISTRATION_STATE_CHANGED'
]);

function registrationErrorData(error) {
  const data = {};
  if (SAFE_REGISTRATION_ERROR_CODES.has(error.code)) data.code = error.code;
  if (error.partialSuccess === true) data.partialSuccess = true;
  if (error.retrySameKey === true) data.retrySameKey = true;
  return Object.keys(data).length ? data : null;
}

function badRequest(res, message) {
  return res.status(400).json({
    success: false,
    message,
    data: null
  });
}

async function register(req, res, next) {
  const input = req.body;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return badRequest(res, 'Request body must be an object');
  }

  if (Object.keys(input).some((field) => !ALLOWED_PATIENT_FIELDS.has(field))) {
    return badRequest(res, 'Request contains unsupported or server-managed fields');
  }

  try {
    const patient = await registerPatient(req.body, req.user);

    return res.status(201).json({
      success: true,
      message: 'Patient registered successfully',
      data: patient
    });
  } catch (error) {
    if (error.name === 'PatientServiceError' && error.partialSuccess === true) {
      return res.status(503).json({
        success: false,
        message: 'Patient registration may already have succeeded, but audit logging failed. Retry the same request with the same idempotencyKey to complete audit recovery without creating another patient.',
        data: registrationErrorData(error)
      });
    }

    if (error.name === 'PatientServiceError' && registrationErrorData(error)) {
      return res.status(error.status || 503).json({
        success: false,
        message: error.message,
        data: registrationErrorData(error)
      });
    }

    return next(error);
  }
}

async function list(req, res, next) {
  try {
    const result = await listPatients(req.query, req.user);
    return res.status(200).json({
      success: true,
      message: 'Patient directory retrieved successfully',
      data: result
    });
  } catch (error) {
    return next(error);
  }
}

async function getDetails(req, res, next) {
  try {
    const patient = await getPatientDetails(req.params.id, req.user);
    return res.status(200).json({
      success: true,
      message: 'Patient identity details retrieved successfully',
      data: patient
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  register,
  list,
  getDetails
};
