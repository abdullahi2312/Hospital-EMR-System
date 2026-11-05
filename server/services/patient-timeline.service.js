const mongoose = require('mongoose');
const Patient = require('../models/Patient');
const Encounter = require('../models/Encounter');
const Vital = require('../models/Vital');
const Diagnosis = require('../models/Diagnosis');
const Prescription = require('../models/Prescription');
const LabOrder = require('../models/LabOrder');
const LabResult = require('../models/LabResult');
const Referral = require('../models/Referral');
const User = require('../models/User');
const { authorizePatientRecordAccess } = require('./patient-access.service');

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_WINDOW = 1000;
const MAX_ENCOUNTERS = 1000;
const MAX_RELATED_LAB_ORDERS = 5000;

function timelineError(message, status = 400) {
  const error = new Error(message);
  error.name = 'PatientTimelineServiceError';
  error.status = status;
  error.statusCode = status;
  return error;
}

function validObjectId(value) {
  return mongoose.isObjectIdOrHexString(value);
}

function parsePositiveInteger(value, field, defaultValue, maximum) {
  if (value === undefined) return defaultValue;
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^\d+$/.test(text)) {
    throw timelineError(`${field} must be a positive whole number`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw timelineError(`${field} must be between 1 and ${maximum}`);
  }
  return parsed;
}

function parseDate(value, field) {
  if (value === undefined) return undefined;
  if (!(value instanceof Date) && typeof value !== 'string') {
    throw timelineError(`${field} must be a valid date`);
  }
  if (typeof value === 'string' && !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(value)) {
    throw timelineError(`${field} must use an ISO date or timestamp`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw timelineError(`${field} must be a valid date`);
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      parsed.toISOString().slice(0, 10) !== value) {
    throw timelineError(`${field} must be a valid calendar date`);
  }
  return parsed;
}

function parseOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw timelineError('Timeline options must be an object');
  }
  const supported = new Set(['page', 'limit', 'from', 'to']);
  if (Object.keys(options).some((key) => !supported.has(key))) {
    throw timelineError('Timeline options contain unsupported fields');
  }

  const page = parsePositiveInteger(options.page, 'Page', DEFAULT_PAGE, MAX_WINDOW);
  const limit = parsePositiveInteger(options.limit, 'Limit', DEFAULT_LIMIT, MAX_LIMIT);
  const offset = (page - 1) * limit;
  if (offset + limit > MAX_WINDOW) {
    throw timelineError(`Requested page exceeds the maximum timeline window of ${MAX_WINDOW} events`);
  }

  const from = parseDate(options.from, 'From date');
  const to = parseDate(options.to, 'To date');
  if (from && to && from > to) throw timelineError('From date must be earlier than or equal to to date');

  return { page, limit, offset, from, to, candidateLimit: offset + limit + 1 };
}

async function requireActiveUser(user) {
  if (!user || typeof user !== 'object' || !validObjectId(user.id)) {
    throw timelineError('Authentication required', 401);
  }
  let currentUser;
  try {
    currentUser = await User.findById(String(user.id)).select('_id role patient isActive').lean();
  } catch (_) {
    throw timelineError('Unable to verify authenticated user', 500);
  }
  if (!currentUser || currentUser.isActive !== true) throw timelineError('Authentication required', 401);
  if (!['patient', 'doctor'].includes(currentUser.role)) {
    throw timelineError('This user role cannot access a clinical timeline', 403);
  }
  return {
    id: currentUser._id.toString(),
    role: currentUser.role,
    ...(currentUser.patient ? { patient: currentUser.patient.toString() } : {})
  };
}

async function verifyPatient(patientId) {
  if (!validObjectId(patientId)) throw timelineError('A valid patient ID is required');
  let patient;
  try {
    patient = await Patient.findById(String(patientId)).select('_id').lean();
  } catch (_) {
    throw timelineError('Unable to retrieve patient record', 500);
  }
  if (!patient) throw timelineError('Patient not found', 404);
  return patient._id;
}

async function authorizePatientTimeline(user, patientId) {
  let access;
  try {
    access = await authorizePatientRecordAccess(user, String(patientId));
  } catch (_) {
    // The patient-access service writes AccessLog records and fails closed if
    // that write fails. Never proceed to timeline reads in that case.
    throw timelineError('Unable to authorize or audit patient-record access', 500);
  }
  if (!access.allowed) throw timelineError(access.message || 'Access to this patient record is not permitted', access.statusCode || 403);
}

async function authorizeEncounterTimeline(user, patientId, encounter) {
  let access;
  try {
    access = await authorizePatientRecordAccess(user, String(patientId), String(encounter._id));
  } catch (_) {
    throw timelineError('Unable to authorize or audit patient-record access', 500);
  }
  return access.allowed === true;
}

function buildDateFilter(dateField, from, to) {
  const bounds = {};
  if (from) bounds.$gte = from;
  if (to) bounds.$lte = to;
  return Object.keys(bounds).length ? { [dateField]: bounds } : {};
}

function timelineQuery(model, filter, projection, dateField, candidateLimit) {
  return model.find(filter)
    .select(projection)
    .sort({ [dateField]: -1, _id: -1 })
    .limit(candidateLimit)
    .lean();
}

function encounterEvent(record) {
  return {
    id: record._id.toString(),
    type: 'encounter',
    date: record.openedAt,
    encounterId: record._id.toString(),
    details: {
      department: record.department,
      visitType: record.visitType,
      status: record.status,
      ...(record.chiefComplaint ? { chiefComplaint: record.chiefComplaint } : {}),
      ...(record.clinicalNotes ? { clinicalNotes: record.clinicalNotes } : {}),
      ...(record.examinationFindings ? { examinationFindings: record.examinationFindings } : {}),
      ...(record.assessment ? { assessment: record.assessment } : {}),
      ...(record.treatmentPlan ? { treatmentPlan: record.treatmentPlan } : {}),
      ...(record.followUpInstructions ? { followUpInstructions: record.followUpInstructions } : {}),
      ...(record.closedAt ? { closedAt: record.closedAt } : {})
    }
  };
}

function vitalEvent(record) {
  return {
    id: record._id.toString(),
    type: 'vital',
    date: record.recordedAt,
    encounterId: record.encounter.toString(),
    details: {
      bloodPressure: { systolic: record.bloodPressure.systolic, diastolic: record.bloodPressure.diastolic },
      temperature: record.temperature,
      pulse: record.pulse,
      weight: record.weight,
      ...(record.height !== undefined ? { height: record.height } : {}),
      ...(record.oxygenSaturation !== undefined ? { oxygenSaturation: record.oxygenSaturation } : {})
    }
  };
}

function diagnosisEvent(record) {
  return {
    id: record._id.toString(),
    type: 'diagnosis',
    date: record.diagnosedAt,
    encounterId: record.encounter.toString(),
    details: {
      ...(record.code ? { code: record.code } : {}),
      description: record.description,
      isPrimary: record.isPrimary
    }
  };
}

function prescriptionEvent(record) {
  return {
    id: record._id.toString(),
    type: 'prescription',
    date: record.prescribedAt,
    encounterId: record.encounter.toString(),
    details: {
      drugName: record.drugName,
      dose: record.dose,
      route: record.route,
      frequency: record.frequency,
      duration: record.duration,
      quantity: record.quantity,
      status: record.status,
      ...(record.instructions ? { instructions: record.instructions } : {})
    }
  };
}

function labOrderEvent(record) {
  return {
    id: record._id.toString(),
    type: 'lab_order',
    date: record.orderedAt,
    encounterId: record.encounter.toString(),
    details: {
      testName: record.testName,
      priority: record.priority,
      status: record.status,
      ...(Array.isArray(record.components) ? {
        components: record.components.map((component) => ({
          componentId: component.componentId,
          name: component.name
        }))
      } : {}),
      ...(record.completedAt ? { completedAt: record.completedAt } : {})
    }
  };
}

function labResultEvent(record, encounterId) {
  return {
    id: record._id.toString(),
    type: 'lab_result',
    date: record.resultedAt,
    encounterId,
    details: {
      labOrderId: record.labOrder.toString(),
      ...(record.componentId ? { componentId: record.componentId } : {}),
      ...(record.componentName ? { componentName: record.componentName } : {}),
      resultType: record.resultType,
      ...(record.numericValue !== undefined ? { numericValue: record.numericValue } : {}),
      ...(record.textValue ? { textValue: record.textValue } : {}),
      ...(record.unit ? { unit: record.unit } : {}),
      ...(record.referenceRange ? {
        referenceRange: {
          ...(record.referenceRange.minimum !== undefined ? { minimum: record.referenceRange.minimum } : {}),
          ...(record.referenceRange.maximum !== undefined ? { maximum: record.referenceRange.maximum } : {})
        }
      } : {}),
      flag: record.flag,
      ...(record.notes ? { notes: record.notes } : {})
    }
  };
}

function referralEvent(record) {
  return {
    id: record._id.toString(),
    type: 'referral',
    date: record.referredAt,
    encounterId: record.encounter.toString(),
    details: {
      receivingHospital: record.receivingHospital,
      ...(record.specialist ? { specialist: record.specialist } : {}),
      reason: record.reason,
      ...(record.clinicalSummary ? { clinicalSummary: record.clinicalSummary } : {}),
      status: record.status
    }
  };
}

async function loadTimelineEvents(patientId, encounterIds, options) {
  const patientFilter = { patient: patientId };
  const relationFilter = encounterIds ? { encounter: { $in: encounterIds } } : {};
  const window = options.candidateLimit;
  const dateFilters = {
    encounter: buildDateFilter('openedAt', options.from, options.to),
    vital: buildDateFilter('recordedAt', options.from, options.to),
    diagnosis: buildDateFilter('diagnosedAt', options.from, options.to),
    prescription: buildDateFilter('prescribedAt', options.from, options.to),
    labOrder: buildDateFilter('orderedAt', options.from, options.to),
    labResult: buildDateFilter('resultedAt', options.from, options.to),
    referral: buildDateFilter('referredAt', options.from, options.to)
  };
  const encounterFilter = encounterIds
    ? { _id: { $in: encounterIds }, patient: patientId, ...dateFilters.encounter }
    : { patient: patientId, ...dateFilters.encounter };
  const baseRelated = { ...patientFilter, ...relationFilter };

  let encounters;
  let vitals;
  let diagnoses;
  let prescriptions;
  let orders;
  let referrals;
  try {
    [encounters, vitals, diagnoses, prescriptions, orders, referrals] = await Promise.all([
      timelineQuery(Encounter, encounterFilter, '_id patient department visitType status chiefComplaint clinicalNotes examinationFindings assessment treatmentPlan followUpInstructions openedAt closedAt', 'openedAt', window),
      timelineQuery(Vital, { ...baseRelated, ...dateFilters.vital }, '_id patient encounter bloodPressure temperature pulse weight height oxygenSaturation recordedAt', 'recordedAt', window),
      timelineQuery(Diagnosis, { ...baseRelated, ...dateFilters.diagnosis }, '_id patient encounter code description isPrimary diagnosedAt', 'diagnosedAt', window),
      timelineQuery(Prescription, { ...baseRelated, ...dateFilters.prescription }, '_id patient encounter drugName dose route frequency duration quantity instructions status prescribedAt', 'prescribedAt', window),
      timelineQuery(LabOrder, { ...baseRelated, ...dateFilters.labOrder }, '_id patient encounter testName components priority status orderedAt completedAt', 'orderedAt', window),
      timelineQuery(Referral, { ...baseRelated, ...dateFilters.referral }, '_id patient encounter receivingHospital specialist reason clinicalSummary status referredAt', 'referredAt', window)
    ]);
  } catch (_) {
    throw timelineError('Unable to retrieve patient timeline records', 500);
  }

  const validEncounterIds = new Set((encounterIds || []).map((id) => String(id)));
  const filteredVitals = vitals.filter((record) => validEncounterIds.has(String(record.encounter)));
  const filteredDiagnoses = diagnoses.filter((record) => validEncounterIds.has(String(record.encounter)));
  const filteredPrescriptions = prescriptions.filter((record) => validEncounterIds.has(String(record.encounter)));
  const filteredOrders = orders.filter((record) => validEncounterIds.has(String(record.encounter)));
  const filteredReferrals = referrals.filter((record) => validEncounterIds.has(String(record.encounter)));

  let allRelatedOrders = [];
  if (encounterIds && encounterIds.length > 0) {
    try {
      allRelatedOrders = await LabOrder.find({ patient: patientId, encounter: { $in: encounterIds } })
        .select('_id encounter')
        .limit(MAX_RELATED_LAB_ORDERS + 1)
        .lean();
    } catch (_) {
      throw timelineError('Unable to verify patient lab order relationships', 500);
    }
    if (allRelatedOrders.length > MAX_RELATED_LAB_ORDERS) {
      throw timelineError(`Patient timeline exceeds the maximum of ${MAX_RELATED_LAB_ORDERS} lab orders for one request.`, 413);
    }
  }

  let results = [];
  if (allRelatedOrders.length > 0) {
    try {
      results = await timelineQuery(
        LabResult,
        {
          patient: patientId,
          labOrder: { $in: allRelatedOrders.map((order) => order._id) },
          ...dateFilters.labResult
        },
        '_id patient labOrder componentId componentName resultType numericValue textValue unit referenceRange flag notes resultedAt',
        'resultedAt',
        window
      );
    } catch (_) {
      throw timelineError('Unable to retrieve patient timeline lab results', 500);
    }
  }

  const encounterByOrder = new Map(allRelatedOrders.map((order) => [String(order._id), String(order.encounter)]));
  const events = [
    ...encounters.map(encounterEvent),
    ...filteredVitals.map(vitalEvent),
    ...filteredDiagnoses.map(diagnosisEvent),
    ...filteredPrescriptions.map(prescriptionEvent),
    ...filteredOrders.map(labOrderEvent),
    ...results
      .filter((result) => encounterByOrder.has(String(result.labOrder)))
      .map((result) => labResultEvent(result, encounterByOrder.get(String(result.labOrder)))),
    ...filteredReferrals.map(referralEvent)
  ].filter((event) => event.date instanceof Date && !Number.isNaN(event.date.getTime()));
  return events;
}

async function getPatientTimeline(patientId, user, options = {}) {
  const currentUser = await requireActiveUser(user);
  if (!validObjectId(patientId)) throw timelineError('A valid patient ID is required');
  if (currentUser.role === 'patient' &&
      (!validObjectId(currentUser.patient) || String(currentUser.patient) !== String(patientId))) {
    throw timelineError('Access to this patient timeline is not permitted', 403);
  }
  const normalizedPatientId = await verifyPatient(patientId);
  const pagination = parseOptions(options);

  if (currentUser.role === 'patient') {
    await authorizePatientTimeline(currentUser, normalizedPatientId);
  }

  let patientEncounters;
  try {
    patientEncounters = await Encounter.find({ patient: normalizedPatientId })
      .select('_id patient assignedDoctor')
      .sort({ openedAt: -1, _id: -1 })
      .limit(MAX_ENCOUNTERS + 1)
      .lean();
  } catch (_) {
    throw timelineError('Unable to retrieve patient encounter history', 500);
  }
  if (patientEncounters.length > MAX_ENCOUNTERS) {
    throw timelineError(`Patient timeline exceeds the maximum of ${MAX_ENCOUNTERS} encounters for one request.`, 413);
  }

  let authorizedEncounterIds;
  if (currentUser.role === 'doctor') {
    if (patientEncounters.length === 0) {
      await authorizePatientTimeline(currentUser, normalizedPatientId);
      authorizedEncounterIds = [];
    } else {
      authorizedEncounterIds = [];
      for (let index = 0; index < patientEncounters.length; index += 10) {
        const batch = patientEncounters.slice(index, index + 10);
        const decisions = await Promise.all(batch.map((encounter) => (
          authorizeEncounterTimeline(currentUser, normalizedPatientId, encounter)
        )));
        batch.forEach((encounter, batchIndex) => {
          if (decisions[batchIndex]) authorizedEncounterIds.push(encounter._id);
        });
      }
      if (authorizedEncounterIds.length === 0) {
        throw timelineError('Access to this patient timeline is not permitted', 403);
      }
    }
  } else {
    authorizedEncounterIds = patientEncounters.map((encounter) => encounter._id);
  }

  const events = await loadTimelineEvents(normalizedPatientId, authorizedEncounterIds, pagination);
  events.sort((left, right) => {
    const timeDifference = new Date(right.date).getTime() - new Date(left.date).getTime();
    if (timeDifference !== 0) return timeDifference;
    return String(right.id).localeCompare(String(left.id));
  });

  const pageEvents = events.slice(pagination.offset, pagination.offset + pagination.limit);
  return {
    events: pageEvents,
    pagination: {
      page: pagination.page,
      limit: pagination.limit,
      hasMore: events.length > pagination.offset + pagination.limit,
      ...(pagination.from ? { from: pagination.from } : {}),
      ...(pagination.to ? { to: pagination.to } : {})
    }
  };
}

module.exports = { getPatientTimeline };
