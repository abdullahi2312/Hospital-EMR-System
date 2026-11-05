const crypto = require('node:crypto');
const mongoose = require('mongoose');
const AuditLog = require('../models/AuditLog');
const Dispense = require('../models/Dispense');
const Encounter = require('../models/Encounter');
const Inventory = require('../models/Inventory');
const Medication = require('../models/Medication');
const Patient = require('../models/Patient');
const Prescription = require('../models/Prescription');
const User = require('../models/User');
const { writeAuditLog } = require('./audit-log.service');

const STOCK_AUDIT_ACTION = 'inventory_stock_added';
const DISPENSE_AUDIT_ACTION = 'prescription_dispensed';
const INVENTORY_ENTITY = 'Inventory';
const DISPENSE_ENTITY = 'Dispense';
const DISPENSABLE_STATUSES = ['pending', 'partially_dispensed'];

function serviceError(message, status = 400, properties = {}) {
  const error = new Error(message);
  error.name = 'PharmacyServiceError';
  error.status = status;
  error.statusCode = status;
  Object.assign(error, properties);
  return error;
}

function validObjectId(value) {
  return mongoose.isObjectIdOrHexString(value);
}

function rejectUnknownFields(input, allowed, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw serviceError(`${label} must be an object`);
  }
  if (Object.keys(input).some((field) => !allowed.has(field))) {
    throw serviceError(`${label} contains unsupported or server-managed fields`);
  }
}

function positiveQuantity(value, label = 'Quantity') {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw serviceError(`${label} must be a positive number`);
  }
  return value;
}

function normalizeText(value, label, maximumLength, required = true) {
  if (value === undefined || value === null) {
    if (required) throw serviceError(`${label} is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw serviceError(`${label} must be text`);
  const normalized = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if ((required && !normalized) || normalized.length > maximumLength) {
    throw serviceError(`${label} is invalid`);
  }
  return normalized || undefined;
}

function normalizeIdempotencyKey(value) {
  const key = normalizeText(value, 'idempotencyKey', 128);
  if (key.length < 8) throw serviceError('idempotencyKey must contain between 8 and 128 characters');
  return key;
}

function hashKey(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function dispenseIdFor(pharmacistId, prescriptionId, idempotencyKey) {
  return new mongoose.Types.ObjectId(
    crypto.createHash('sha256')
      .update(`dispense:${pharmacistId}:${prescriptionId}:${idempotencyKey}`)
      .digest()
      .subarray(0, 12)
  );
}

async function requireActivePharmacist(user) {
  if (!user || typeof user !== 'object' || !validObjectId(user.id)) {
    throw serviceError('Authentication required', 401);
  }
  let currentUser;
  try {
    currentUser = await User.findById(String(user.id)).select('_id role isActive').lean();
  } catch (_) {
    throw serviceError('Unable to verify authenticated user', 500);
  }
  if (!currentUser || currentUser.isActive !== true) {
    throw serviceError('Authentication required', 401);
  }
  if (currentUser.role !== 'pharmacist') {
    throw serviceError('Only active pharmacists may manage pharmacy inventory or dispensing', 403);
  }
  return { id: currentUser._id.toString(), role: currentUser.role };
}

function serializeInventory(inventory) {
  return {
    id: inventory._id.toString(),
    medication: inventory.medication.toString(),
    batchNumber: inventory.batchNumber,
    quantity: inventory.quantity,
    minimumStock: inventory.minimumStock,
    unit: inventory.unit,
    expiryDate: inventory.expiryDate,
    ...(inventory.supplier ? { supplier: inventory.supplier } : {}),
    ...(inventory.location ? { location: inventory.location } : {}),
    updatedAt: inventory.updatedAt
  };
}

async function getMedicationInventory(medicationId, user) {
  await requireActivePharmacist(user);
  if (!validObjectId(medicationId)) throw serviceError('A valid medication ID is required');

  let medication;
  let inventory;
  try {
    medication = await Medication.findById(String(medicationId))
      .select('_id name genericName brandName strength dosageForm isActive')
      .lean();
  } catch (_) {
    throw serviceError('Unable to retrieve medication', 500);
  }
  if (!medication || medication.isActive !== true) {
    throw serviceError('Active medication not found', 404);
  }
  try {
    inventory = await Inventory.find({ medication: medication._id })
      .sort({ expiryDate: 1, _id: 1 })
      .lean();
  } catch (_) {
    throw serviceError('Unable to retrieve medication inventory', 500);
  }
  return {
    medication: {
      id: medication._id.toString(),
      name: medication.name,
      ...(medication.genericName ? { genericName: medication.genericName } : {}),
      ...(medication.brandName ? { brandName: medication.brandName } : {}),
      strength: medication.strength,
      dosageForm: medication.dosageForm
    },
    inventory: inventory.map(serializeInventory)
  };
}

async function findStockAdditionAudit(pharmacistId, inventoryId, operationHash) {
  try {
    return await AuditLog.findOne({
      actor: pharmacistId,
      action: STOCK_AUDIT_ACTION,
      entityType: INVENTORY_ENTITY,
      entityId: inventoryId,
      'details.operationHash': operationHash
    }).select('_id details.quantityAdded').lean();
  } catch (_) {
    throw serviceError('Unable to verify prior stock addition', 503);
  }
}

async function addInventoryStock(input, user) {
  const pharmacist = await requireActivePharmacist(user);
  rejectUnknownFields(input, new Set(['inventoryId', 'quantity', 'idempotencyKey']), 'Stock addition input');
  if (!validObjectId(input.inventoryId)) throw serviceError('A valid inventory ID is required');
  const quantity = positiveQuantity(input.quantity, 'Stock addition quantity');
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const operationHash = hashKey(`${pharmacist.id}:${input.inventoryId}:${idempotencyKey}`);

  const previousAddition = await findStockAdditionAudit(
    pharmacist.id,
    String(input.inventoryId),
    operationHash
  );
  if (previousAddition) {
    if (previousAddition.details?.quantityAdded !== quantity) {
      throw serviceError('This idempotencyKey was already used for a different stock addition', 409);
    }
    let currentInventory;
    try {
      currentInventory = await Inventory.findById(String(input.inventoryId)).lean();
    } catch (_) {
      throw serviceError('Stock addition was recorded, but current inventory could not be retrieved', 503, {
        partialSuccess: true,
        inventoryId: String(input.inventoryId)
      });
    }
    if (!currentInventory) throw serviceError('Inventory record not found', 404);
    return { ...serializeInventory(currentInventory), replayed: true };
  }

  let inventory;
  try {
    inventory = await Inventory.findById(String(input.inventoryId)).select('_id medication unit expiryDate').lean();
  } catch (_) {
    throw serviceError('Unable to verify inventory record', 500);
  }
  if (!inventory) throw serviceError('Inventory record not found', 404);

  let medication;
  try {
    medication = await Medication.findById(String(inventory.medication)).select('_id isActive').lean();
  } catch (_) {
    throw serviceError('Unable to verify inventory medication', 500);
  }
  if (!medication || medication.isActive !== true) {
    throw serviceError('Inventory medication is inactive or unavailable', 409);
  }
  if (!(inventory.expiryDate instanceof Date) || inventory.expiryDate.getTime() <= Date.now()) {
    throw serviceError('Expired inventory cannot receive stock', 409);
  }

  let updated;
  try {
    updated = await Inventory.findOneAndUpdate(
      {
        _id: inventory._id,
        medication: medication._id,
        quantity: { $gte: 0 },
        expiryDate: { $gt: new Date() }
      },
      {
        $inc: { quantity },
        $set: { lastUpdatedBy: pharmacist.id }
      },
      { new: true, runValidators: true }
    );
  } catch (_) {
    throw serviceError('Unable to add stock', 500);
  }
  if (!updated) throw serviceError('Inventory changed or expired before stock could be added', 409);

  try {
    await writeAuditLog({
      actorId: pharmacist.id,
      action: STOCK_AUDIT_ACTION,
      entityType: INVENTORY_ENTITY,
      entityId: updated._id,
      details: {
        quantityAdded: quantity,
        operationHash
      }
    });
  } catch (_) {
    throw serviceError(
      'Stock was updated, but audit logging failed. Verify the inventory quantity before attempting another addition.',
      503,
      { partialSuccess: true, inventoryId: updated._id.toString() }
    );
  }
  return serializeInventory(updated);
}

function attachSession(query, session) {
  return typeof query.session === 'function' ? query.session(session) : query;
}

async function loadPrescriptionContext(prescriptionId, session) {
  let prescription;
  try {
    const query = Prescription.findById(prescriptionId).lean();
    prescription = await attachSession(query, session);
  } catch (_) {
    throw serviceError('Unable to retrieve prescription', 500);
  }
  if (!prescription) throw serviceError('Prescription not found', 404);
  if (!validObjectId(prescription.patient) || !validObjectId(prescription.encounter)) {
    throw serviceError('Prescription references are invalid', 500);
  }

  let encounter;
  let patient;
  try {
    const encounterQuery = Encounter.findById(String(prescription.encounter)).select('_id patient').lean();
    const patientQuery = Patient.exists({ _id: prescription.patient });
    [encounter, patient] = await Promise.all([
      attachSession(encounterQuery, session),
      attachSession(patientQuery, session)
    ]);
  } catch (_) {
    throw serviceError('Unable to verify prescription patient and encounter', 500);
  }
  if (!encounter || !patient) throw serviceError('Prescription patient or encounter was not found', 404);
  if (String(encounter.patient) !== String(prescription.patient)) {
    throw serviceError('Prescription patient does not match its encounter', 409);
  }
  return { prescription, patientId: String(prescription.patient), encounterId: String(encounter._id) };
}

async function getActiveMedicationForPrescription(prescription, session) {
  const normalizedName = typeof prescription.drugName === 'string'
    ? prescription.drugName.normalize('NFKC').trim().toLocaleLowerCase('en')
    : '';
  if (!normalizedName) throw serviceError('Prescription medication is invalid', 409);
  let matches;
  try {
    const query = Medication.find({ name: normalizedName, isActive: true })
      .select('_id name isActive')
      .lean();
    matches = await attachSession(query, session);
  } catch (_) {
    throw serviceError('Unable to verify prescribed medication', 500);
  }
  if (matches.length === 0) throw serviceError('Active prescribed medication was not found', 409);
  if (matches.length > 1) throw serviceError('Prescribed medication is ambiguous in the catalog', 409);
  return matches[0];
}

function sameDispense(dispense, data, pharmacistId, patientId) {
  return String(dispense.prescription) === data.prescriptionId &&
    String(dispense.patient) === patientId &&
    String(dispense.inventory) === data.inventoryId &&
    String(dispense.pharmacist) === pharmacistId &&
    dispense.quantityDispensed === data.quantity &&
    (dispense.notes || undefined) === data.notes;
}

function serializeDispense(dispense) {
  return {
    id: dispense._id.toString(),
    prescription: dispense.prescription.toString(),
    patient: dispense.patient.toString(),
    medication: dispense.medication.toString(),
    inventory: dispense.inventory.toString(),
    pharmacist: dispense.pharmacist.toString(),
    quantityDispensed: dispense.quantityDispensed,
    unit: dispense.unit,
    ...(dispense.notes ? { notes: dispense.notes } : {}),
    dispensedAt: dispense.dispensedAt
  };
}

async function ensureDispenseAudit(dispense, pharmacistId) {
  let audit;
  try {
    audit = await AuditLog.findOne({
      actor: pharmacistId,
      action: DISPENSE_AUDIT_ACTION,
      entityType: DISPENSE_ENTITY,
      entityId: dispense._id
    }).select('_id').lean();
  } catch (_) {
    throw serviceError('Dispense may have been saved, but audit state could not be verified. Retry using the same idempotencyKey.', 503, {
      partialSuccess: true,
      dispenseId: dispense._id.toString(),
      prescriptionId: dispense.prescription.toString()
    });
  }
  if (audit) return;
  try {
    await writeAuditLog({
      actorId: pharmacistId,
      action: DISPENSE_AUDIT_ACTION,
      entityType: DISPENSE_ENTITY,
      entityId: dispense._id
    });
  } catch (_) {
    throw serviceError(
      'Dispense was committed, but audit logging failed. Retry using the same idempotencyKey to avoid a duplicate.',
      503,
      { partialSuccess: true, dispenseId: dispense._id.toString(), prescriptionId: dispense.prescription.toString() }
    );
  }
}

async function getDispenseById(dispenseId) {
  try {
    return await Dispense.findById(dispenseId).lean();
  } catch (_) {
    throw serviceError('Unable to verify a previous dispensing operation', 503);
  }
}

async function dispensePrescription(input, user) {
  const pharmacist = await requireActivePharmacist(user);
  rejectUnknownFields(
    input,
    new Set(['prescriptionId', 'inventoryId', 'quantity', 'notes', 'idempotencyKey']),
    'Dispense input'
  );
  if (!validObjectId(input.prescriptionId)) throw serviceError('A valid prescription ID is required');
  if (!validObjectId(input.inventoryId)) throw serviceError('A valid inventory ID is required');
  const quantity = positiveQuantity(input.quantity, 'Dispense quantity');
  const notes = normalizeText(input.notes, 'Dispense notes', 2000, false);
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const data = {
    prescriptionId: String(input.prescriptionId),
    inventoryId: String(input.inventoryId),
    quantity,
    notes
  };
  const dispenseId = dispenseIdFor(pharmacist.id, data.prescriptionId, idempotencyKey);

  const existing = await getDispenseById(dispenseId);
  let context;
  try {
    context = await loadPrescriptionContext(data.prescriptionId);
  } catch (error) {
    if (existing) throw serviceError('Previously recorded dispense cannot be verified against its prescription', 409);
    throw error;
  }
  if (existing) {
    if (!sameDispense(existing, data, pharmacist.id, context.patientId)) {
      throw serviceError('This idempotencyKey was already used for a different dispense', 409);
    }
    await ensureDispenseAudit(existing, pharmacist.id);
    return { ...serializeDispense(existing), replayed: true };
  }

  if (!DISPENSABLE_STATUSES.includes(context.prescription.status)) {
    throw serviceError('Prescription is not eligible for dispensing', 409);
  }

  let session;
  try {
    session = await mongoose.startSession();
  } catch (_) {
    throw serviceError('Dispensing requires a transaction-capable MongoDB deployment', 503, {
      transactionUnavailable: true
    });
  }

  let committedDispense;
  let transactionError;
  try {
    await session.withTransaction(async () => {
      const transactionContext = await loadPrescriptionContext(data.prescriptionId, session);
      const prescription = transactionContext.prescription;
      if (!DISPENSABLE_STATUSES.includes(prescription.status)) {
        throw serviceError('Prescription is not eligible for dispensing', 409);
      }

      const medication = await getActiveMedicationForPrescription(prescription, session);
      let inventory;
      try {
        const inventoryQuery = Inventory.findById(data.inventoryId).session(session).lean();
        inventory = await inventoryQuery;
      } catch (_) {
        throw serviceError('Unable to verify inventory batch', 500);
      }
      if (!inventory) throw serviceError('Inventory batch not found', 404);
      if (String(inventory.medication) !== String(medication._id)) {
        throw serviceError('Inventory batch does not match the prescribed medication', 409);
      }
      if (!(inventory.expiryDate instanceof Date) || inventory.expiryDate.getTime() <= Date.now()) {
        throw serviceError('Expired inventory cannot be dispensed', 409);
      }

      let previousDispenses;
      try {
        previousDispenses = await Dispense.find({ prescription: prescription._id })
          .select('quantityDispensed unit')
          .session(session)
          .lean();
      } catch (_) {
        throw serviceError('Unable to calculate remaining prescription quantity', 500);
      }
      const priorUnits = new Set(previousDispenses.map((dispense) => dispense.unit));
      if (priorUnits.size > 1 || (priorUnits.size === 1 && !priorUnits.has(inventory.unit))) {
        throw serviceError('Inventory unit does not match previous dispenses for this prescription', 409);
      }
      const alreadyDispensed = previousDispenses.reduce(
        (total, dispense) => total + Number(dispense.quantityDispensed || 0),
        0
      );
      if (!Number.isFinite(prescription.quantity) || prescription.quantity <= 0 ||
          alreadyDispensed > prescription.quantity) {
        throw serviceError('Prescription quantity or dispensing history is inconsistent', 409);
      }
      const remaining = prescription.quantity - alreadyDispensed;
      if (quantity > remaining) {
        throw serviceError('Dispense quantity exceeds the remaining prescribed quantity', 409, {
          remainingQuantity: remaining
        });
      }

      const now = new Date();
      let stockResult;
      try {
        stockResult = await Inventory.updateOne(
          {
            _id: inventory._id,
            medication: medication._id,
            quantity: { $gte: quantity },
            expiryDate: { $gt: now }
          },
          { $inc: { quantity: -quantity }, $set: { lastUpdatedBy: pharmacist.id } },
          { session, runValidators: true }
        );
      } catch (_) {
        throw serviceError('Unable to reserve inventory stock', 500);
      }
      if (stockResult.matchedCount === 0) {
        throw serviceError('Insufficient available stock in this inventory batch', 409);
      }

      const dispense = new Dispense({
        _id: dispenseId,
        prescription: prescription._id,
        patient: prescription.patient,
        medication: medication._id,
        inventory: inventory._id,
        pharmacist: pharmacist.id,
        quantityDispensed: quantity,
        unit: inventory.unit,
        ...(notes ? { notes } : {}),
        dispensedAt: now
      });
      try {
        await dispense.save({ session });
      } catch (error) {
        if (error.code === 11000) throw serviceError('This dispense request has already been recorded', 409);
        if (error.name === 'ValidationError' || error.name === 'CastError') {
          throw serviceError('Dispense data is invalid', 400);
        }
        throw serviceError('Unable to save dispense record', 500);
      }

      const nextDispensed = alreadyDispensed + quantity;
      const nextStatus = nextDispensed >= prescription.quantity ? 'dispensed' : 'partially_dispensed';
      const version = Number.isInteger(prescription.__v) ? prescription.__v : 0;
      let prescriptionUpdate;
      try {
        prescriptionUpdate = await Prescription.updateOne(
          {
            _id: prescription._id,
            status: { $in: DISPENSABLE_STATUSES },
            $or: [{ __v: version }, { __v: { $exists: false } }]
          },
          { $set: { status: nextStatus }, $inc: { __v: 1 } },
          { session, runValidators: true }
        );
      } catch (_) {
        throw serviceError('Unable to update prescription dispensing status', 500);
      }
      if (prescriptionUpdate.matchedCount === 0) {
        throw serviceError('Prescription changed during dispensing; retry with the same idempotencyKey', 409);
      }
      committedDispense = dispense;
    });
  } catch (error) {
    transactionError = error;
  } finally {
    if (session && typeof session.endSession === 'function') await session.endSession();
  }

  if (transactionError) {
    const possiblyCommitted = await getDispenseById(dispenseId);
    if (possiblyCommitted && sameDispense(possiblyCommitted, data, pharmacist.id, context.patientId)) {
      await ensureDispenseAudit(possiblyCommitted, pharmacist.id);
      return { ...serializeDispense(possiblyCommitted), replayed: true };
    }
    if (transactionError.name === 'PharmacyServiceError') throw transactionError;
    if (isTransactionUnsupported(transactionError)) {
      throw serviceError(
        'Dispensing requires MongoDB transactions. Configure a replica set or sharded cluster; no dispense was confirmed.',
        503,
        { transactionUnavailable: true }
      );
    }
    throw serviceError(
      'Dispensing transaction did not complete. Retry with the same idempotencyKey to safely verify the outcome.',
      503,
      { partialSuccess: true, dispenseId: dispenseId.toString(), prescriptionId: data.prescriptionId }
    );
  }

  if (!committedDispense) {
    // A transaction callback may return without writing if another identical
    // request committed first; recover from the deterministic dispense ID.
    const concurrent = await getDispenseById(dispenseId);
    if (!concurrent) throw serviceError('Dispense transaction completed without a dispense record', 503);
    committedDispense = concurrent;
  }
  await ensureDispenseAudit(committedDispense, pharmacist.id);
  return serializeDispense(committedDispense);
}

function isTransactionUnsupported(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  return error?.code === 20 || error?.codeName === 'IllegalOperation' ||
    /transaction numbers are only allowed|does not support transactions|transactions are not supported/i.test(message);
}

module.exports = {
  getMedicationInventory,
  addInventoryStock,
  dispensePrescription
};
