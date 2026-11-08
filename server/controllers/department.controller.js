'use strict';

const { listActiveDepartments, createDepartment } = require('../services/department.service');

async function list(_req, res, next) {
  try {
    return res.status(200).json({ success: true, message: 'Active departments retrieved successfully', data: { departments: await listActiveDepartments() } });
  } catch (error) { return next(error); }
}

async function create(req, res, next) {
  try {
    const department = await createDepartment(req.body, req.user);
    return res.status(201).json({ success: true, message: 'Department created successfully', data: { department } });
  } catch (error) {
    if (error.name === 'DepartmentServiceError' && error.partialSuccess) {
      return res.status(503).json({ success: false, message: error.message, data: { partialSuccess: true } });
    }
    if (error.name === 'DepartmentServiceError') {
      return res.status(error.status || 400).json({ success: false, message: error.message, data: null });
    }
    return next(error);
  }
}

module.exports = { list, create };
