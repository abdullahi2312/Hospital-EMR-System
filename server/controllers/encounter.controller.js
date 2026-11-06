const mongoose = require('mongoose');
const {
  createEncounter,
  assignEncounterDoctor,
  getEncounterDetails,
  listEncounters,
  closeEncounter
} = require('../services/encounter.service');

const CREATE_FIELDS = new Set(['patient', 'department', 'visitType', 'chiefComplaint', 'idempotencyKey']);
const ASSIGN_FIELDS = new Set(['doctorId', 'idempotencyKey']);
const LIST_QUERY_FIELDS = new Set(['page', 'limit']);

function badRequest(res, message) {
  return res.status(400).json({ success: false, message, data: null });
}

function isObjectBody(body) {
  return Boolean(body && typeof body === 'object' && !Array.isArray(body));
}

function hasUnknownFields(value, allowedFields) {
  return Object.keys(value).some((field) => !allowedFields.has(field));
}

function hasInvalidGetBody(body) {
  return body !== undefined && body !== null && (!isObjectBody(body) || Object.keys(body).length > 0);
}

function validId(value) {
  return mongoose.isObjectIdOrHexString(value);
}

function handleServiceError(error, res, next, action) {
  if (error?.name === 'EncounterServiceError' && error.partialSuccess === true) {
    return res.status(error.status || 503).json({
      success: false,
      message: `The encounter ${action} may already have succeeded, but audit logging did not complete. Verify the encounter before retrying.`,
      data: {
        partialSuccess: true,
        ...(error.encounterId ? { encounterId: error.encounterId } : {})
      }
    });
  }
  return next(error);
}

async function create(req, res, next) {
  if (Object.keys(req.query).length > 0) return badRequest(res, 'Query parameters are not supported for encounter creation');
  const body = req.body;
  if (!isObjectBody(body)) return badRequest(res, 'Request body must be an object');
  if (hasUnknownFields(body, CREATE_FIELDS)) {
    return badRequest(res, 'Request contains unsupported or server-managed fields');
  }

  try {
    const encounter = await createEncounter(body, req.user);
    return res.status(encounter.replayed ? 200 : 201).json({
      success: true,
      message: encounter.replayed ? 'Previously created encounter returned' : 'Encounter created successfully',
      data: encounter
    });
  } catch (error) {
    return handleServiceError(error, res, next, 'creation');
  }
}

async function assign(req, res, next) {
  if (!validId(req.params.id)) return badRequest(res, 'A valid encounter ID is required');
  if (Object.keys(req.query).length > 0) return badRequest(res, 'Query parameters are not supported for doctor assignment');
  const body = req.body;
  if (!isObjectBody(body)) return badRequest(res, 'Request body must be an object');
  if (hasUnknownFields(body, ASSIGN_FIELDS)) {
    return badRequest(res, 'Request contains unsupported or server-managed fields');
  }

  try {
    const encounter = await assignEncounterDoctor({
      encounterId: req.params.id,
      ...(Object.hasOwn(body, 'doctorId') ? { doctorId: body.doctorId } : {}),
      ...(Object.hasOwn(body, 'idempotencyKey') ? { idempotencyKey: body.idempotencyKey } : {})
    }, req.user);
    return res.status(200).json({
      success: true,
      message: encounter.replayed ? 'Previously assigned encounter returned' : 'Encounter doctor assignment updated successfully',
      data: encounter
    });
  } catch (error) {
    return handleServiceError(error, res, next, 'assignment');
  }
}

async function list(req, res, next) {
  if (hasInvalidGetBody(req.body)) {
    return badRequest(res, 'GET requests must not contain a request body');
  }
  if (hasUnknownFields(req.query, LIST_QUERY_FIELDS)) {
    return badRequest(res, 'Query contains unsupported fields');
  }
  try {
    const result = await listEncounters(req.query, req.user);
    return res.status(200).json({ success: true, message: 'Encounters retrieved successfully', data: result });
  } catch (error) {
    return handleServiceError(error, res, next, 'listing');
  }
}

async function details(req, res, next) {
  if (!validId(req.params.id)) return badRequest(res, 'A valid encounter ID is required');
  if (Object.keys(req.query).length > 0) return badRequest(res, 'Query parameters are not supported for encounter details');
  if (hasInvalidGetBody(req.body)) {
    return badRequest(res, 'GET requests must not contain a request body');
  }
  try {
    const encounter = await getEncounterDetails(req.params.id, req.user);
    return res.status(200).json({ success: true, message: 'Encounter details retrieved successfully', data: encounter });
  } catch (error) {
    return handleServiceError(error, res, next, 'retrieval');
  }
}

async function close(req, res, next) {
  if (!validId(req.params.id)) return badRequest(res, 'A valid encounter ID is required');
  if (hasInvalidGetBody(req.body)) {
    return badRequest(res, 'Encounter closure does not accept request body fields');
  }
  if (Object.keys(req.query).length > 0) return badRequest(res, 'Query parameters are not supported for encounter closure');
  try {
    const encounter = await closeEncounter({ encounterId: req.params.id }, req.user);
    return res.status(200).json({
      success: true,
      message: encounter.replayed ? 'Encounter was already closed' : 'Encounter closed successfully',
      data: encounter
    });
  } catch (error) {
    return handleServiceError(error, res, next, 'closure');
  }
}

module.exports = { create, assign, list, details, close };
