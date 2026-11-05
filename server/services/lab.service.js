const crypto = require('node:crypto');
const mongoose = require('mongoose');
const AuditLog = require('../models/AuditLog');
const Encounter = require('../models/Encounter');
const LabOrder = require('../models/LabOrder');
const LabResult = require('../models/LabResult');
const Patient = require('../models/Patient');
const User = require('../models/User');
const { authorizePatientRecordAccess } = require('./patient-access.service');
const { writeAuditLog } = require('./audit-log.service');

const ORDER_AUDIT_ACTION = 'lab_order_created';
const CANCELLATION_AUDIT_ACTION = 'lab_order_cancelled';
const RESULT_AUDIT_ACTION = 'lab_result_recorded';
const REJECTION_AUDIT_ACTION = 'lab_sample_rejected';
const ORDER_ENTITY = 'LabOrder';
const RESULT_ENTITY = 'LabResult';
const ORDER_PRIORITIES = ['routine', 'urgent', 'emergency'];
const ORDER_RESULTABLE_STATUSES = ['pending', 'sample_collected', 'processing'];
const REJECTABLE_STATUSES = ['pending', 'sample_collected', 'processing'];
const CANCELLABLE_STATUSES = ['pending', 'sample_collected', 'processing'];

function serviceError(message, status = 400, properties = {}) {
  const error = new Error(message);
  error.name = 'LabServiceError';
  error.status = status;
  error.statusCode = status;
  Object.assign(error, properties);
  return error;
}

function validObjectId(value) {
  return mongoose.isObjectIdOrHexString(value);
}

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw serviceError(`${name} must be an object`);
  }
}

function rejectUnknownFields(input, allowed, label) {
  if (Object.keys(input).some((field) => !allowed.has(field))) {
    throw serviceError(`${label} contains unsupported or server-managed fields`);
  }
}

function normalizeText(value, field, maxLength, required = true, minimum = 1) {
  if (value === undefined || value === null) {
    if (required) throw serviceError(`${field} is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw serviceError(`${field} must be text`);
  const normalized = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if ((required && normalized.length < minimum) || normalized.length > maxLength) {
    throw serviceError(`${field} is invalid`);
  }
  return normalized || undefined;
}

function normalizeIdempotencyKey(value) {
  if (typeof value !== 'string') {
    throw serviceError('An idempotencyKey between 8 and 128 characters is required');
  }
  const key = value.trim();
  if (key.length < 8 || key.length > 128) {
    throw serviceError('An idempotencyKey between 8 and 128 characters is required');
  }
  return key;
}

function normalizeComponents(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw serviceError('components must be a non-empty array when provided');
  }
  const ids = new Set();
  return value.map((component) => {
    requireObject(component, 'Lab component');
    rejectUnknownFields(component, new Set(['componentId', 'name']), 'Lab component');
    const componentId = normalizeText(component.componentId, 'Component ID', 80)
      .toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(componentId)) {
      throw serviceError('Component ID format is invalid');
    }
    if (ids.has(componentId)) throw serviceError('Lab component IDs must be unique');
    ids.add(componentId);
    return { componentId, name: normalizeText(component.name, 'Component name', 200) };
  });
}

function componentsForOrder(order) {
  return Array.isArray(order.components) && order.components.length > 0
    ? order.components.map((component) => ({
      componentId: String(component.componentId).toLowerCase(),
      name: component.name
    }))
    : [{ componentId: 'default', name: order.testName }];
}

function deterministicId(kind, ownerId, parentId, key) {
  const identity = `${kind}:${ownerId}:${parentId || ''}:${key}`;
  return new mongoose.Types.ObjectId(
    crypto.createHash('sha256').update(identity).digest().subarray(0, 12)
  );
}

async function requireActiveRole(user, role, label) {
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
  if (currentUser.role !== role) {
    throw serviceError(`Only active ${label}s may perform this lab operation`, 403);
  }
  return { id: currentUser._id.toString(), role: currentUser.role };
}

async function loadDoctorEncounter(encounterId, doctor) {
  if (!validObjectId(encounterId)) throw serviceError('A valid encounter ID is required');
  let encounter;
  try {
    encounter = await Encounter.findById(String(encounterId)).select('_id patient').lean();
  } catch (_) {
    throw serviceError('Unable to verify encounter', 500);
  }
  if (!encounter) throw serviceError('Encounter not found', 404);
  if (!validObjectId(encounter.patient)) throw serviceError('Encounter patient is invalid', 500);

  let patientExists;
  try {
    patientExists = await Patient.exists({ _id: encounter.patient });
  } catch (_) {
    throw serviceError('Unable to verify encounter patient', 500);
  }
  if (!patientExists) throw serviceError('Encounter patient not found', 404);

  let access;
  try {
    access = await authorizePatientRecordAccess(
      doctor,
      String(encounter.patient),
      String(encounter._id),
      'Create laboratory order'
    );
  } catch (_) {
    throw serviceError('Unable to verify patient-record access', 500);
  }
  if (!access.allowed) {
    throw serviceError(
      access.message || 'Access to this patient record is not permitted',
      access.statusCode || 403
    );
  }
  return encounter;
}

function sameOrder(order, data, doctorId, patientId, encounterId) {
  return String(order.doctor) === doctorId &&
    String(order.patient) === patientId &&
    String(order.encounter) === encounterId &&
    order.testName === data.testName &&
    (order.instructions || undefined) === data.instructions &&
    order.priority === data.priority &&
    JSON.stringify(order.components || undefined) === JSON.stringify(data.components);
}

function serializeOrder(order) {
  return {
    id: order._id.toString(),
    patient: order.patient.toString(),
    encounter: order.encounter.toString(),
    doctor: order.doctor.toString(),
    testName: order.testName,
    ...(Array.isArray(order.components) && order.components.length
      ? { components: order.components.map((component) => ({
        componentId: component.componentId,
        name: component.name
      })) }
      : {}),
    ...(order.instructions ? { instructions: order.instructions } : {}),
    priority: order.priority,
    status: order.status,
    ...(order.technician ? { technician: order.technician.toString() } : {}),
    ...(order.rejectionReason ? { rejectionReason: order.rejectionReason } : {}),
    ...(order.cancelledBy ? { cancelledBy: order.cancelledBy.toString() } : {}),
    ...(order.cancelledAt ? { cancelledAt: order.cancelledAt } : {}),
    orderedAt: order.orderedAt,
    ...(order.completedAt ? { completedAt: order.completedAt } : {})
  };
}

async function ensureAudit({ actorId, action, entityType, entityId, partialEntityId, label }) {
  let event;
  try {
    event = await AuditLog.findOne({ actor: actorId, action, entityType, entityId })
      .select('_id')
      .lean();
  } catch (_) {
    throw serviceError(`Unable to verify ${label} audit state`, 503, {
      partialSuccess: true,
      ...(partialEntityId ? { [partialEntityId.name]: partialEntityId.value } : {})
    });
  }
  if (event) return;
  try {
    // Never put patient identity, test names, results, units, ranges, or notes in audit details.
    await writeAuditLog({ actorId, action, entityType, entityId });
  } catch (_) {
    throw serviceError(
      `${label} was saved, but audit logging failed. Retry with the same idempotencyKey where supported.`,
      503,
      {
        partialSuccess: true,
        ...(partialEntityId ? { [partialEntityId.name]: partialEntityId.value } : {})
      }
    );
  }
}

async function createLabOrder(input, user) {
  const doctor = await requireActiveRole(user, 'doctor', 'doctor');
  requireObject(input, 'Lab order input');
  const allowed = new Set(['encounter', 'testName', 'components', 'instructions', 'priority', 'idempotencyKey']);
  rejectUnknownFields(input, allowed, 'Lab order input');
  if (!validObjectId(input.encounter)) throw serviceError('A valid encounter ID is required');

  const data = {
    encounterId: String(input.encounter),
    testName: normalizeText(input.testName, 'Test name', 200),
    components: normalizeComponents(input.components),
    instructions: normalizeText(input.instructions, 'Instructions', 2000, false),
    priority: input.priority === undefined ? 'routine' : normalizeText(input.priority, 'Priority', 20),
    idempotencyKey: normalizeIdempotencyKey(input.idempotencyKey)
  };
  if (!ORDER_PRIORITIES.includes(data.priority)) {
    throw serviceError('Priority must be routine, urgent, or emergency');
  }
  const encounter = await loadDoctorEncounter(data.encounterId, doctor);
  const patientId = String(encounter.patient);
  const orderId = deterministicId('lab-order', doctor.id, undefined, data.idempotencyKey);

  let existing;
  try {
    existing = await LabOrder.findById(orderId).lean();
  } catch (_) {
    throw serviceError('Unable to check for a previous lab order submission', 500);
  }
  if (existing) {
    if (!sameOrder(existing, data, doctor.id, patientId, data.encounterId)) {
      throw serviceError('This idempotencyKey was already used for a different lab order', 409);
    }
    await ensureAudit({
      actorId: doctor.id,
      action: ORDER_AUDIT_ACTION,
      entityType: ORDER_ENTITY,
      entityId: existing._id,
      partialEntityId: { name: 'labOrderId', value: existing._id.toString() },
      label: 'Lab order'
    });
    return { ...serializeOrder(existing), replayed: true };
  }

  const order = new LabOrder({
    _id: orderId,
    patient: encounter.patient,
    encounter: encounter._id,
    doctor: doctor.id,
    testName: data.testName,
    ...(data.components ? { components: data.components } : {}),
    ...(data.instructions ? { instructions: data.instructions } : {}),
    priority: data.priority,
    status: 'pending',
    orderedAt: new Date()
  });
  try {
    await order.save();
  } catch (error) {
    if (error.code === 11000) {
      const concurrent = await LabOrder.findById(orderId).lean();
      if (concurrent && sameOrder(concurrent, data, doctor.id, patientId, data.encounterId)) {
        await ensureAudit({
          actorId: doctor.id,
          action: ORDER_AUDIT_ACTION,
          entityType: ORDER_ENTITY,
          entityId: concurrent._id,
          partialEntityId: { name: 'labOrderId', value: concurrent._id.toString() },
          label: 'Lab order'
        });
        return { ...serializeOrder(concurrent), replayed: true };
      }
      throw serviceError('Lab order submission could not be saved safely', 409);
    }
    if (error.name === 'ValidationError' || error.name === 'CastError') {
      throw serviceError('Lab order data is invalid', 400);
    }
    throw serviceError('Unable to save lab order', 500);
  }

  await ensureAudit({
    actorId: doctor.id,
    action: ORDER_AUDIT_ACTION,
    entityType: ORDER_ENTITY,
    entityId: order._id,
    partialEntityId: { name: 'labOrderId', value: order._id.toString() },
    label: 'Lab order'
  });
  return serializeOrder(order);
}

async function loadActiveTechnician(user) {
  return requireActiveRole(user, 'lab_technician', 'lab technician');
}

function technicianCanAccess(order, technicianId) {
  return order.technician == null || String(order.technician) === technicianId;
}

async function loadLabContext(order) {
  if (!validObjectId(order.patient) || !validObjectId(order.encounter)) {
    throw serviceError('Lab order references are invalid', 500);
  }
  let patient;
  let encounter;
  try {
    [patient, encounter] = await Promise.all([
      Patient.findById(String(order.patient)).select('_id mrn firstName fatherName grandfatherName').lean(),
      Encounter.findById(String(order.encounter)).select('_id patient visitNumber department status').lean()
    ]);
  } catch (_) {
    throw serviceError('Unable to retrieve lab order context', 500);
  }
  if (!patient || !encounter) throw serviceError('Lab order context was not found', 404);
  if (String(encounter.patient) !== String(patient._id)) {
    throw serviceError('Lab order encounter and patient do not match', 409);
  }
  return {
    patient: {
      id: patient._id.toString(),
      mrn: patient.mrn,
      name: [patient.firstName, patient.fatherName, patient.grandfatherName].filter(Boolean).join(' ')
    },
    encounter: {
      id: encounter._id.toString(),
      visitNumber: encounter.visitNumber,
      department: encounter.department,
      status: encounter.status
    }
  };
}

function serializeTechnicianOrder(order, context) {
  return {
    ...serializeOrder(order),
    patient: context.patient,
    encounter: context.encounter
  };
}

async function listPendingLabOrders(user, options = {}) {
  const technician = await loadActiveTechnician(user);
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some((field) => field !== 'limit')) {
    throw serviceError('Pending lab order options are invalid');
  }
  const limit = options.limit === undefined ? 50 : options.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw serviceError('Limit must be an integer between 1 and 100');
  }

  let orders;
  try {
    orders = await LabOrder.find({
      status: 'pending',
      $or: [{ technician: null }, { technician: technician.id }]
    }).sort({ orderedAt: 1, _id: 1 }).limit(limit).lean();
  } catch (_) {
    throw serviceError('Unable to retrieve pending lab orders', 500);
  }
  const result = [];
  for (const order of orders) {
    try {
      result.push(serializeTechnicianOrder(order, await loadLabContext(order)));
    } catch (error) {
      if (error.status === 404 || error.status === 409) continue;
      throw error;
    }
  }
  return result;
}

async function getLabOrderDetails(orderId, user) {
  const technician = await loadActiveTechnician(user);
  if (!validObjectId(orderId)) throw serviceError('A valid lab order ID is required');
  let order;
  try {
    order = await LabOrder.findById(String(orderId)).lean();
  } catch (_) {
    throw serviceError('Unable to retrieve lab order', 500);
  }
  if (!order) throw serviceError('Lab order not found', 404);
  if (!technicianCanAccess(order, technician.id)) {
    throw serviceError('This lab order is assigned to another technician', 403);
  }
  return serializeTechnicianOrder(order, await loadLabContext(order));
}

async function cancelLabOrder(input, user) {
  const doctor = await requireActiveRole(user, 'doctor', 'doctor');
  requireObject(input, 'Lab order cancellation input');
  rejectUnknownFields(
    input,
    new Set(['encounterId', 'orderId', 'idempotencyKey']),
    'Lab order cancellation input'
  );
  if (!validObjectId(input.encounterId)) throw serviceError('A valid encounter ID is required');
  if (!validObjectId(input.orderId)) throw serviceError('A valid lab order ID is required');
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const requestHash = crypto.createHash('sha256').update(idempotencyKey).digest('hex');

  let order;
  try {
    order = await LabOrder.findById(String(input.orderId))
      .select('+cancellationRequestHash')
      .lean();
  } catch (_) {
    throw serviceError('Unable to retrieve lab order for cancellation', 500);
  }
  if (!order) throw serviceError('Lab order not found', 404);
  if (String(order.doctor) !== doctor.id) {
    throw serviceError('Only the doctor who ordered this test may cancel it', 403);
  }

  const encounter = await loadDoctorEncounter(input.encounterId, doctor);
  if (String(order.encounter) !== String(encounter._id) ||
      String(order.patient) !== String(encounter.patient)) {
    throw serviceError('Lab order does not belong to the specified encounter', 400);
  }

  if (order.status === 'cancelled') {
    if (String(order.cancelledBy) !== doctor.id || order.cancellationRequestHash !== requestHash) {
      throw serviceError('Lab order has already been cancelled', 409);
    }
    await ensureAudit({
      actorId: doctor.id,
      action: CANCELLATION_AUDIT_ACTION,
      entityType: ORDER_ENTITY,
      entityId: order._id,
      partialEntityId: { name: 'labOrderId', value: order._id.toString() },
      label: 'Lab order cancellation'
    });
    return { ...serializeOrder(order), replayed: true };
  }
  if (!CANCELLABLE_STATUSES.includes(order.status)) {
    throw serviceError('Completed, rejected, or otherwise ineligible lab orders cannot be cancelled', 409);
  }

  let cancelled;
  try {
    cancelled = await LabOrder.findOneAndUpdate(
      {
        _id: order._id,
        encounter: encounter._id,
        patient: encounter.patient,
        doctor: doctor.id,
        status: { $in: CANCELLABLE_STATUSES }
      },
      {
        $set: {
          status: 'cancelled',
          cancelledBy: doctor.id,
          cancelledAt: new Date(),
          cancellationRequestHash: requestHash
        }
      },
      { new: true, runValidators: true }
    );
  } catch (error) {
    if (error.name === 'ValidationError' || error.name === 'CastError') {
      throw serviceError('Lab order cancellation data is invalid', 400);
    }
    throw serviceError('Unable to cancel lab order', 500);
  }
  if (!cancelled) throw serviceError('Lab order is no longer eligible for cancellation', 409);

  await ensureAudit({
    actorId: doctor.id,
    action: CANCELLATION_AUDIT_ACTION,
    entityType: ORDER_ENTITY,
    entityId: cancelled._id,
    partialEntityId: { name: 'labOrderId', value: cancelled._id.toString() },
    label: 'Lab order cancellation'
  });
  return serializeOrder(cancelled);
}

function normalizeLabResult(input) {
  requireObject(input, 'Lab result input');
  const allowed = new Set([
    'orderId', 'componentId', 'resultType', 'numericValue', 'textValue', 'unit',
    'referenceRange', 'notes', 'idempotencyKey'
  ]);
  rejectUnknownFields(input, allowed, 'Lab result input');
  if (!validObjectId(input.orderId)) throw serviceError('A valid lab order ID is required');
  const componentId = normalizeText(input.componentId, 'Component ID', 80, false)?.toLowerCase();
  if (componentId && !/^[a-z0-9][a-z0-9._-]*$/.test(componentId)) {
    throw serviceError('Component ID format is invalid');
  }
  if (!['numeric', 'text'].includes(input.resultType)) {
    throw serviceError('Result type must be numeric or text');
  }

  let numericValue;
  let textValue;
  if (input.resultType === 'numeric') {
    if (typeof input.numericValue !== 'number' || !Number.isFinite(input.numericValue)) {
      throw serviceError('Numeric results require a finite numericValue');
    }
    if (input.textValue !== undefined) throw serviceError('textValue is not allowed for numeric results');
    numericValue = input.numericValue;
  } else {
    textValue = normalizeText(input.textValue, 'Text result', 2000);
    if (input.numericValue !== undefined) throw serviceError('numericValue is not allowed for text results');
  }

  let referenceRange;
  if (input.referenceRange !== undefined) {
    const range = input.referenceRange;
    if (!range || typeof range !== 'object' || Array.isArray(range)) {
      throw serviceError('Reference range must be an object');
    }
    if (Object.keys(range).some((field) => !['minimum', 'maximum'].includes(field))) {
      throw serviceError('Reference range may contain only minimum and maximum');
    }
    if (input.resultType !== 'numeric') {
      throw serviceError('Reference ranges are supported only for numeric results');
    }
    const hasMinimum = range.minimum !== undefined && range.minimum !== null;
    const hasMaximum = range.maximum !== undefined && range.maximum !== null;
    if (!hasMinimum && !hasMaximum) throw serviceError('Reference range must include a minimum or maximum');
    if (hasMinimum && (typeof range.minimum !== 'number' || !Number.isFinite(range.minimum))) {
      throw serviceError('Reference range minimum must be finite');
    }
    if (hasMaximum && (typeof range.maximum !== 'number' || !Number.isFinite(range.maximum))) {
      throw serviceError('Reference range maximum must be finite');
    }
    if (hasMinimum && hasMaximum && range.minimum > range.maximum) {
      throw serviceError('Reference range minimum cannot exceed maximum');
    }
    referenceRange = {
      ...(hasMinimum ? { minimum: range.minimum } : {}),
      ...(hasMaximum ? { maximum: range.maximum } : {})
    };
  }

  let flag = 'unclassified';
  if (input.resultType === 'numeric' && referenceRange) {
    if (referenceRange.minimum !== undefined && numericValue < referenceRange.minimum) flag = 'low';
    else if (referenceRange.maximum !== undefined && numericValue > referenceRange.maximum) flag = 'high';
    else flag = 'normal';
  }

  return {
    orderId: String(input.orderId),
    ...(componentId ? { componentId } : {}),
    resultType: input.resultType,
    ...(numericValue !== undefined ? { numericValue } : {}),
    ...(textValue !== undefined ? { textValue } : {}),
    unit: normalizeText(input.unit, 'Unit', 50, false),
    ...(referenceRange ? { referenceRange } : {}),
    notes: normalizeText(input.notes, 'Notes', 2000, false),
    idempotencyKey: normalizeIdempotencyKey(input.idempotencyKey),
    flag
  };
}

function sameResult(result, data, technicianId, patientId) {
  return String(result.labOrder) === data.orderId &&
    String(result.patient) === patientId &&
    String(result.technician) === technicianId &&
    (result.componentId || 'default') === data.componentId &&
    (result.componentName || data.componentName) === data.componentName &&
    result.resultType === data.resultType &&
    result.numericValue === data.numericValue &&
    (result.textValue || undefined) === data.textValue &&
    (result.unit || undefined) === data.unit &&
    JSON.stringify(result.referenceRange || undefined) === JSON.stringify(data.referenceRange) &&
    (result.notes || undefined) === data.notes &&
    result.flag === data.flag;
}

function serializeResult(result) {
  return {
    id: result._id.toString(),
    labOrder: result.labOrder.toString(),
    patient: result.patient.toString(),
    technician: result.technician.toString(),
    ...(result.componentId ? { componentId: result.componentId } : {}),
    ...(result.componentName ? { componentName: result.componentName } : {}),
    resultType: result.resultType,
    ...(result.numericValue !== undefined ? { numericValue: result.numericValue } : {}),
    ...(result.textValue !== undefined ? { textValue: result.textValue } : {}),
    ...(result.unit ? { unit: result.unit } : {}),
    ...(result.referenceRange ? { referenceRange: result.referenceRange } : {}),
    flag: result.flag,
    ...(result.notes ? { notes: result.notes } : {}),
    resultedAt: result.resultedAt
  };
}

async function findOrder(orderId) {
  try {
    return await LabOrder.findById(orderId).lean();
  } catch (_) {
    throw serviceError('Unable to verify lab order', 500);
  }
}

async function ensureOrderProgress(order, technicianId, resultId) {
  async function allRequiredResultsPresent(orderRecord) {
    let recordedResults;
    try {
      recordedResults = await LabResult.find({ labOrder: orderRecord._id }).select('componentId').lean();
    } catch (_) {
      throw serviceError('Unable to verify required lab components', 503, {
        partialSuccess: true,
        labResultId: String(resultId),
        labOrderId: orderRecord._id.toString()
      });
    }
    const recordedComponentIds = new Set(recordedResults.map((result) => (
      result.componentId ? String(result.componentId).toLowerCase() : 'default'
    )));
    return componentsForOrder(orderRecord)
      .every((component) => recordedComponentIds.has(component.componentId));
  }
  const allComponentsHaveResults = await allRequiredResultsPresent(order);

  if (order.status === 'completed') {
    if (String(order.technician) === technicianId && allComponentsHaveResults) return order;
    throw serviceError('Completed lab order has incomplete component results', 409, {
      labResultId: String(resultId),
      labOrderId: order._id.toString()
    });
  }
  if (!ORDER_RESULTABLE_STATUSES.includes(order.status) || !technicianCanAccess(order, technicianId)) {
    throw serviceError('This lab order is not eligible for result recording', 409);
  }
  const update = { technician: technicianId };
  if (allComponentsHaveResults) {
    update.status = 'completed';
    update.completedAt = new Date();
  }
  let updated;
  try {
    updated = await LabOrder.findOneAndUpdate(
      {
        _id: order._id,
        status: { $in: ORDER_RESULTABLE_STATUSES },
        $or: [{ technician: null }, { technician: technicianId }]
      },
      { $set: update },
      { new: true, runValidators: true }
    );
  } catch (_) {
    throw serviceError('Unable to complete lab order', 500, { resultId: String(resultId) });
  }
  if (!updated) {
    // Another component submission may have completed the order after this
    // request read its previous status. Recheck before treating that race as a
    // conflict or removing this request's valid component result.
    let latestOrder;
    try {
      latestOrder = await LabOrder.findById(order._id).lean();
    } catch (_) {
      throw serviceError('Unable to verify lab order completion', 503, {
        partialSuccess: true,
        labResultId: String(resultId),
        labOrderId: order._id.toString()
      });
    }
    if (
      latestOrder &&
      latestOrder.status === 'completed' &&
      String(latestOrder.technician) === technicianId &&
      await allRequiredResultsPresent(latestOrder)
    ) {
      return latestOrder;
    }
    throw serviceError('This lab order is no longer eligible for result recording', 409, {
      resultId: String(resultId)
    });
  }
  return updated;
}

async function claimLabOrderForTechnician(order, technicianId) {
  if (!ORDER_RESULTABLE_STATUSES.includes(order.status)) {
    throw serviceError('This lab order is not eligible for result recording', 409);
  }
  if (!technicianCanAccess(order, technicianId)) {
    throw serviceError('This lab order is assigned to another technician', 403);
  }
  if (String(order.technician) === technicianId) return order;

  let claimed;
  try {
    claimed = await LabOrder.findOneAndUpdate(
      {
        _id: order._id,
        status: { $in: ORDER_RESULTABLE_STATUSES },
        $or: [{ technician: null }, { technician: technicianId }]
      },
      { $set: { technician: technicianId } },
      { new: true, runValidators: true }
    );
  } catch (_) {
    throw serviceError('Unable to assign lab order to technician', 500);
  }
  if (claimed) return claimed;

  const current = await findOrder(order._id);
  if (current && ORDER_RESULTABLE_STATUSES.includes(current.status) &&
      String(current.technician) === technicianId) {
    return current;
  }
  throw serviceError('This lab order is no longer available for result recording', 409);
}

async function recordLabResult(input, user) {
  const technician = await loadActiveTechnician(user);
  const data = normalizeLabResult(input);
  let order = await findOrder(data.orderId);
  if (!order) throw serviceError('Lab order not found', 404);
  if (!technicianCanAccess(order, technician.id)) {
    throw serviceError('This lab order is assigned to another technician', 403);
  }
  if (!validObjectId(order.patient)) throw serviceError('Lab order patient reference is invalid', 500);
  const context = await loadLabContext(order);
  const requiredComponents = componentsForOrder(order);
  let component;
  if (Array.isArray(order.components) && order.components.length > 0) {
    if (!data.componentId) {
      throw serviceError('componentId is required for a multi-component lab order');
    }
    component = requiredComponents.find((entry) => entry.componentId === data.componentId);
    if (!component) throw serviceError('Component is not defined for this lab order', 400);
  } else {
    if (data.componentId && data.componentId !== 'default') {
      throw serviceError('Component is not defined for this lab order', 400);
    }
    component = requiredComponents[0];
  }
  data.componentId = component.componentId;
  data.componentName = component.name;
  const resultId = deterministicId(
    'lab-result',
    technician.id,
    data.componentId === 'default' ? data.orderId : `${data.orderId}:${data.componentId}`,
    data.idempotencyKey
  );

  let existing;
  try {
    existing = await LabResult.findById(resultId).lean();
  } catch (_) {
    throw serviceError('Unable to check for a previous lab result submission', 500);
  }
  if (existing) {
    if (!sameResult(existing, data, technician.id, String(order.patient))) {
      throw serviceError('This idempotencyKey was already used for a different lab result', 409);
    }
    await ensureOrderProgress(order, technician.id, existing._id);
    await ensureAudit({
      actorId: technician.id,
      action: RESULT_AUDIT_ACTION,
      entityType: RESULT_ENTITY,
      entityId: existing._id,
      partialEntityId: { name: 'labResultId', value: existing._id.toString() },
      label: 'Lab result'
    });
    return { result: serializeResult(existing), orderId: order._id.toString(), replayed: true };
  }
  let existingComponent;
  try {
    const componentFilter = data.componentId === 'default'
      ? {
        labOrder: order._id,
        $or: [{ componentId: 'default' }, { componentId: { $exists: false } }]
      }
      : { labOrder: order._id, componentId: data.componentId };
    existingComponent = await LabResult.findOne(componentFilter).select('_id').lean();
  } catch (_) {
    throw serviceError('Unable to check for a result already recorded for this component', 500);
  }
  if (existingComponent) {
    throw serviceError('A result has already been recorded for this component', 409);
  }
  if (!ORDER_RESULTABLE_STATUSES.includes(order.status)) {
    throw serviceError('This lab order is not eligible for result recording', 409);
  }

  order = await claimLabOrderForTechnician(order, technician.id);

  const result = new LabResult({
    _id: resultId,
    labOrder: order._id,
    patient: order.patient,
    technician: technician.id,
    componentId: data.componentId,
    componentName: data.componentName,
    resultType: data.resultType,
    ...(data.numericValue !== undefined ? { numericValue: data.numericValue } : {}),
    ...(data.textValue !== undefined ? { textValue: data.textValue } : {}),
    ...(data.unit ? { unit: data.unit } : {}),
    ...(data.referenceRange ? { referenceRange: data.referenceRange } : {}),
    flag: data.flag,
    ...(data.notes ? { notes: data.notes } : {}),
    resultedAt: new Date()
  });
  try {
    await result.save();
  } catch (error) {
    if (error.code === 11000) {
      const concurrent = await LabResult.findById(resultId).lean();
      if (concurrent && sameResult(concurrent, data, technician.id, String(order.patient))) {
        await ensureOrderProgress(order, technician.id, concurrent._id);
        await ensureAudit({
          actorId: technician.id,
          action: RESULT_AUDIT_ACTION,
          entityType: RESULT_ENTITY,
          entityId: concurrent._id,
          partialEntityId: { name: 'labResultId', value: concurrent._id.toString() },
          label: 'Lab result'
        });
        return { result: serializeResult(concurrent), orderId: order._id.toString(), replayed: true };
      }
      throw serviceError('Lab result submission could not be saved safely', 409);
    }
    if (error.name === 'ValidationError' || error.name === 'CastError') {
      throw serviceError('Lab result data is invalid', 400);
    }
    throw serviceError('Unable to save lab result', 500);
  }

  try {
    await ensureOrderProgress(order, technician.id, result._id);
  } catch (error) {
    try {
      await LabResult.deleteOne({ _id: result._id });
    } catch (_) {
      throw serviceError(
        'Lab result may have been saved but the order could not be completed. Verify both records before retrying.',
        503,
        { partialSuccess: true, labResultId: result._id.toString(), labOrderId: order._id.toString() }
      );
    }
    throw error;
  }

  await ensureAudit({
    actorId: technician.id,
    action: RESULT_AUDIT_ACTION,
    entityType: RESULT_ENTITY,
    entityId: result._id,
    partialEntityId: { name: 'labResultId', value: result._id.toString() },
    label: 'Lab result'
  });
  return { result: serializeResult(result), orderId: order._id.toString() };
}

async function rejectLabSample(input, user) {
  const technician = await loadActiveTechnician(user);
  requireObject(input, 'Sample rejection input');
  rejectUnknownFields(input, new Set(['orderId', 'reason']), 'Sample rejection input');
  if (!validObjectId(input.orderId)) throw serviceError('A valid lab order ID is required');
  const reason = normalizeText(input.reason, 'Rejection reason', 1000, true, 10);
  const orderId = String(input.orderId);
  const order = await findOrder(orderId);
  if (!order) throw serviceError('Lab order not found', 404);
  if (!technicianCanAccess(order, technician.id)) {
    throw serviceError('This lab order is assigned to another technician', 403);
  }

  if (order.status === 'sample_rejected') {
    if (String(order.technician) !== technician.id || order.rejectionReason !== reason) {
      throw serviceError('This lab sample has already been rejected', 409);
    }
    await ensureAudit({
      actorId: technician.id,
      action: REJECTION_AUDIT_ACTION,
      entityType: ORDER_ENTITY,
      entityId: order._id,
      partialEntityId: { name: 'labOrderId', value: order._id.toString() },
      label: 'Sample rejection'
    });
    return { ...serializeOrder(order), replayed: true };
  }
  if (!REJECTABLE_STATUSES.includes(order.status)) {
    throw serviceError('This lab order is not eligible for sample rejection', 409);
  }

  let updated;
  try {
    updated = await LabOrder.findOneAndUpdate(
      {
        _id: order._id,
        status: { $in: REJECTABLE_STATUSES },
        $or: [{ technician: null }, { technician: technician.id }]
      },
      { $set: { status: 'sample_rejected', rejectionReason: reason, technician: technician.id } },
      { new: true, runValidators: true }
    );
  } catch (error) {
    if (error.name === 'ValidationError' || error.name === 'CastError') {
      throw serviceError('Sample rejection data is invalid', 400);
    }
    throw serviceError('Unable to reject lab sample', 500);
  }
  if (!updated) throw serviceError('This lab order is no longer eligible for sample rejection', 409);

  await ensureAudit({
    actorId: technician.id,
    action: REJECTION_AUDIT_ACTION,
    entityType: ORDER_ENTITY,
    entityId: updated._id,
    partialEntityId: { name: 'labOrderId', value: updated._id.toString() },
    label: 'Sample rejection'
  });
  return serializeOrder(updated);
}

module.exports = {
  createLabOrder,
  listPendingLabOrders,
  getLabOrderDetails,
  cancelLabOrder,
  recordLabResult,
  rejectLabSample
};
