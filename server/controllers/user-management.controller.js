const mongoose = require('mongoose');
const {
  createManagedUser,
  getManagedUser,
  listManagedUsers,
  updateManagedUserStatus
} = require('../services/user-management.service');

const CREATE_FIELDS = new Set([
  'fullName', 'username', 'password', 'role', 'patient', 'phone', 'idempotencyKey'
]);
const LIST_QUERY_FIELDS = new Set(['page', 'limit']);
const STATUS_FIELDS = new Set(['isActive', 'idempotencyKey']);

function badRequest(res, message) {
  return res.status(400).json({ success: false, message, data: null });
}

function isObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hasUnknownFields(value, allowed) {
  return Object.keys(value).some((field) => !allowed.has(field));
}

function rejectUnsupportedQuery(req, res) {
  if (Object.keys(req.query).length > 0) {
    badRequest(res, 'Query parameters are not supported for this endpoint');
    return true;
  }
  return false;
}

function hasInvalidGetBody(body) {
  return body !== undefined && body !== null && (!isObject(body) || Object.keys(body).length > 0);
}

function validId(value) {
  return mongoose.isObjectIdOrHexString(value);
}

function paginationError(query) {
  for (const [field, maximum] of [['page', 1000000], ['limit', 100]]) {
    if (query[field] === undefined) continue;
    const value = query[field];
    if (typeof value !== 'string' || !/^\d+$/.test(value)) {
      return `${field} must be a positive whole number`;
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
      return `${field} must be between 1 and ${maximum}`;
    }
  }
  return undefined;
}

function safeUser(user) {
  if (!user || typeof user !== 'object') return user;
  return {
    ...(user.id ? { id: String(user.id) } : {}),
    ...(user.fullName !== undefined ? { fullName: user.fullName } : {}),
    ...(user.username !== undefined ? { username: user.username } : {}),
    ...(user.role !== undefined ? { role: user.role } : {}),
    ...(user.patient ? { patient: String(user.patient) } : {}),
    ...(user.isActive !== undefined ? { isActive: user.isActive } : {}),
    ...(user.createdAt ? { createdAt: user.createdAt } : {}),
    ...(user.updatedAt ? { updatedAt: user.updatedAt } : {}),
    ...(user.replayed === true ? { replayed: true } : {})
  };
}

function handleServiceError(error, res, next, action) {
  if (error?.name === 'UserManagementServiceError' && error.partialSuccess === true) {
    return res.status(error.status || 503).json({
      success: false,
      message: `The account ${action} may already have succeeded, but audit logging did not complete. Check the existing account before retrying.`,
      data: {
        partialSuccess: true,
        ...(error.userId ? { userId: String(error.userId) } : {})
      }
    });
  }
  if (error?.name === 'UserManagementServiceError' && Number(error.status) >= 500) {
    return res.status(error.status).json({
      success: false,
      message: 'Unable to complete the user-management request',
      data: null
    });
  }
  return next(error);
}

async function create(req, res, next) {
  if (rejectUnsupportedQuery(req, res)) return;
  if (!isObject(req.body)) return badRequest(res, 'Request body must be an object');
  if (hasUnknownFields(req.body, CREATE_FIELDS)) {
    return badRequest(res, 'Request contains unsupported or server-managed fields');
  }
  if (req.body.role !== 'patient' && Object.hasOwn(req.body, 'patient')) {
    return badRequest(res, 'Patient linkage is allowed only for patient accounts');
  }

  try {
    const user = await createManagedUser(req.body, req.user);
    return res.status(user.replayed ? 200 : 201).json({
      success: true,
      message: user.replayed ? 'Previously created user returned' : 'User created successfully',
      data: safeUser(user)
    });
  } catch (error) {
    return handleServiceError(error, res, next, 'creation');
  }
}

async function list(req, res, next) {
  if (hasInvalidGetBody(req.body)) return badRequest(res, 'GET requests must not contain a request body');
  if (hasUnknownFields(req.query, LIST_QUERY_FIELDS)) {
    return badRequest(res, 'Query contains unsupported fields');
  }
  const invalidPagination = paginationError(req.query);
  if (invalidPagination) return badRequest(res, invalidPagination);
  try {
    const result = await listManagedUsers(req.query, req.user);
    return res.status(200).json({
      success: true,
      message: 'Users retrieved successfully',
      data: {
        users: Array.isArray(result.users) ? result.users.map(safeUser) : [],
        pagination: result.pagination ? {
          ...(result.pagination.page !== undefined ? { page: result.pagination.page } : {}),
          ...(result.pagination.limit !== undefined ? { limit: result.pagination.limit } : {}),
          ...(result.pagination.total !== undefined ? { total: result.pagination.total } : {}),
          ...(result.pagination.totalPages !== undefined ? { totalPages: result.pagination.totalPages } : {})
        } : undefined
      }
    });
  } catch (error) {
    return handleServiceError(error, res, next, 'listing');
  }
}

async function details(req, res, next) {
  if (!validId(req.params.userId)) return badRequest(res, 'A valid user ID is required');
  if (rejectUnsupportedQuery(req, res)) return;
  if (hasInvalidGetBody(req.body)) return badRequest(res, 'GET requests must not contain a request body');
  try {
    const user = await getManagedUser(req.params.userId, req.user);
    return res.status(200).json({ success: true, message: 'User retrieved successfully', data: safeUser(user) });
  } catch (error) {
    return handleServiceError(error, res, next, 'retrieval');
  }
}

async function updateStatus(req, res, next) {
  if (!validId(req.params.userId)) return badRequest(res, 'A valid user ID is required');
  if (rejectUnsupportedQuery(req, res)) return;
  if (!isObject(req.body)) return badRequest(res, 'Request body must be an object');
  if (hasUnknownFields(req.body, STATUS_FIELDS)) {
    return badRequest(res, 'Request contains unsupported or server-managed fields');
  }
  try {
    const user = await updateManagedUserStatus({
      userId: req.params.userId,
      ...(Object.hasOwn(req.body, 'isActive') ? { isActive: req.body.isActive } : {}),
      ...(Object.hasOwn(req.body, 'idempotencyKey') ? { idempotencyKey: req.body.idempotencyKey } : {})
    }, req.user);
    return res.status(200).json({
      success: true,
      message: user.replayed ? 'User account status already has the requested value' : 'User account status updated successfully',
      data: safeUser(user)
    });
  } catch (error) {
    return handleServiceError(error, res, next, 'status change');
  }
}

module.exports = { create, list, details, updateStatus };
