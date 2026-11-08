const mongoose = require('mongoose');
const {
  getMedicationInventory,
  listPendingPrescriptions,
  getPharmacistPrescriptionDetails,
  addInventoryStock,
  dispensePrescription
} = require('../services/pharmacy.service');

const STOCK_FIELDS = new Set(['quantity', 'idempotencyKey']);
const DISPENSE_FIELDS = new Set(['inventoryId', 'quantity', 'notes', 'idempotencyKey']);

function badRequest(res, message) {
  return res.status(400).json({ success: false, message, data: null });
}

function validateBody(body, allowedFields) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'Request body must be an object';
  }
  if (Object.keys(body).some((field) => !allowedFields.has(field))) {
    return 'Request contains unsupported or server-managed fields';
  }
  return null;
}

function validId(value) {
  return mongoose.isObjectIdOrHexString(value);
}

function respondWithServiceError(error, res, next) {
  if (error.name !== 'PharmacyServiceError') return next(error);

  const status = Number(error.status || error.statusCode) || 500;
  if (status >= 500 && status !== 503) return next(error);

  const data = error.partialSuccess === true
    ? {
        partialSuccess: true,
        ...(error.inventoryId ? { inventoryId: error.inventoryId } : {}),
        ...(error.dispenseId ? { dispenseId: error.dispenseId } : {}),
        ...(error.prescriptionId ? { prescriptionId: error.prescriptionId } : {})
      }
    : error.transactionUnavailable === true
      ? { transactionUnavailable: true }
      : null;

  return res.status(status).json({
    success: false,
    message: status >= 500 ? error.message || 'Pharmacy operation could not be completed' : error.message,
    data
  });
}

async function getInventory(req, res, next) {
  if (!validId(req.params.medicationId)) return badRequest(res, 'A valid medication ID is required');
  try {
    const inventory = await getMedicationInventory(req.params.medicationId, req.user);
    return res.status(200).json({
      success: true,
      message: 'Medication inventory retrieved successfully',
      data: inventory
    });
  } catch (error) {
    return respondWithServiceError(error, res, next);
  }
}

async function listPending(req, res, next) {
  if (Object.keys(req.query).some((key) => !['page', 'limit'].includes(key))) {
    return badRequest(res, 'Request contains unsupported query parameters');
  }
  try {
    const result = await listPendingPrescriptions({ page: req.query.page, limit: req.query.limit }, req.user);
    return res.status(200).json({
      success: true,
      message: 'Pending prescriptions retrieved successfully',
      data: result
    });
  } catch (error) {
    return respondWithServiceError(error, res, next);
  }
}

async function prescriptionDetails(req, res, next) {
  if (!validId(req.params.prescriptionId)) return badRequest(res, 'A valid prescription ID is required');
  try {
    const prescription = await getPharmacistPrescriptionDetails(req.params.prescriptionId, req.user);
    return res.status(200).json({
      success: true,
      message: 'Prescription details retrieved successfully',
      data: prescription
    });
  } catch (error) {
    return respondWithServiceError(error, res, next);
  }
}

async function addStock(req, res, next) {
  if (!validId(req.params.inventoryId)) return badRequest(res, 'A valid inventory ID is required');
  const bodyError = validateBody(req.body, STOCK_FIELDS);
  if (bodyError) return badRequest(res, bodyError);

  try {
    const inventory = await addInventoryStock({
      inventoryId: req.params.inventoryId,
      quantity: req.body.quantity,
      idempotencyKey: req.body.idempotencyKey
    }, req.user);
    return res.status(200).json({
      success: true,
      message: inventory.replayed ? 'Previously recorded stock addition returned' : 'Inventory stock added successfully',
      data: inventory
    });
  } catch (error) {
    return respondWithServiceError(error, res, next);
  }
}

async function dispense(req, res, next) {
  if (!validId(req.params.prescriptionId)) return badRequest(res, 'A valid prescription ID is required');
  const bodyError = validateBody(req.body, DISPENSE_FIELDS);
  if (bodyError) return badRequest(res, bodyError);
  if (!validId(req.body.inventoryId)) return badRequest(res, 'A valid inventory ID is required');

  try {
    const result = await dispensePrescription({
      prescriptionId: req.params.prescriptionId,
      inventoryId: req.body.inventoryId,
      quantity: req.body.quantity,
      ...(req.body.notes !== undefined ? { notes: req.body.notes } : {}),
      idempotencyKey: req.body.idempotencyKey
    }, req.user);
    return res.status(result.replayed ? 200 : 201).json({
      success: true,
      message: result.replayed ? 'Previously recorded dispense returned' : 'Prescription dispensed successfully',
      data: result
    });
  } catch (error) {
    return respondWithServiceError(error, res, next);
  }
}

module.exports = { getInventory, listPending, prescriptionDetails, addStock, dispense };
