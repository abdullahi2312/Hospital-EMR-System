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
  'allergyStatus'
]);

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
        message: 'Patient registration may already have succeeded, but audit logging failed. Verify the patient record before retrying.',
        data: null
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
