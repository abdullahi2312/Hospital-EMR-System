'use strict';

const Department = require('../models/Department');
const User = require('../models/User');
const { writeAuditLog } = require('./audit-log.service');

function departmentError(message, status = 400, extra = {}) {
  const error = new Error(message);
  error.name = 'DepartmentServiceError';
  error.status = status;
  error.statusCode = status;
  Object.assign(error, extra);
  return error;
}

async function listActiveDepartments() {
  const records = await Department.find({ isActive: true })
    .select('_id name code')
    .sort({ name: 1 })
    .lean();
  return records.map(({ _id, name, code }) => ({ id: String(_id), name, code }));
}

async function createDepartment(input, actor) {
  if (!actor?.id) throw departmentError('Authentication required', 401);
  const current = await User.findById(actor.id).select('_id role isActive').lean();
  if (!current || current.isActive !== true) throw departmentError('Authentication required', 401);
  if (current.role !== 'admin') throw departmentError('Only administrators may create departments', 403);
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some((field) => !['name', 'code', 'description'].includes(field))) {
    throw departmentError('Only name, code, and description may be provided');
  }
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const code = typeof input.code === 'string' ? input.code.trim().toUpperCase() : '';
  if (input.description !== undefined && typeof input.description !== 'string') {
    throw departmentError('Department description must be text no longer than 1000 characters');
  }
  const description = input.description === undefined ? undefined : input.description.trim();
  if (!name || name.length > 100) throw departmentError('Department name must be between 1 and 100 characters');
  if (!code || code.length > 30 || !/^[A-Z0-9_-]+$/.test(code)) throw departmentError('Department code must contain 1 to 30 letters, numbers, underscores, or hyphens');
  if (description !== undefined && description.length > 1000) {
    throw departmentError('Department description must be text no longer than 1000 characters');
  }

  let department;
  try {
    department = await Department.create({ name, code, ...(description ? { description } : {}), isActive: true });
  } catch (error) {
    if (error?.code === 11000) throw departmentError('A department with that name or code already exists', 409);
    if (error?.name === 'ValidationError') throw departmentError('Department details are invalid');
    throw departmentError('Unable to create department', 500);
  }

  try {
    await writeAuditLog({ actorId: current._id, action: 'department_created', entityType: 'Department', entityId: department._id });
  } catch (_) {
    throw departmentError('Department was created, but audit logging failed. Refresh the department list before retrying.', 503, { partialSuccess: true });
  }
  return { id: String(department._id), name: department.name, code: department.code, isActive: department.isActive };
}

module.exports = { listActiveDepartments, createDepartment };
