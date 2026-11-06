'use strict';

const mongoose = require('mongoose');
const Patient = require('../models/Patient');
const Encounter = require('../models/Encounter');
const Vital = require('../models/Vital');
const LabOrder = require('../models/LabOrder');
const LabResult = require('../models/LabResult');
const Prescription = require('../models/Prescription');
const User = require('../models/User');
const { authorizePatientRecordAccess } = require('./patient-access.service');

const FHIR_ACCESS_REASON = 'FHIR read-only resource access';
const SAFE_PATIENT_FIELDS = '_id mrn firstName fatherName grandfatherName sex dateOfBirth phone district createdAt updatedAt';
const SAFE_ENCOUNTER_FIELDS = '_id patient visitNumber department assignedDoctor status visitType chiefComplaint clinicalNotes examinationFindings assessment treatmentPlan followUpInstructions openedAt closedAt createdAt updatedAt';
const SAFE_VITAL_FIELDS = '_id patient encounter bloodPressure temperature pulse respiratoryRate weight height oxygenSaturation recordedAt';
const SAFE_LAB_RESULT_FIELDS = '_id patient labOrder componentId componentName resultType numericValue textValue unit referenceRange flag resultedAt';
const SAFE_LAB_ORDER_FIELDS = '_id patient encounter testName status';
const SAFE_PRESCRIPTION_FIELDS = '_id patient encounter drugName dose route frequency duration quantity instructions status prescribedAt';

function fhirError(message, status = 400) {
  const error = new Error(message);
  error.name = 'FhirServiceError';
  error.status = status;
  error.statusCode = status;
  return error;
}

function validId(value) {
  return mongoose.isObjectIdOrHexString(value);
}

async function requireCurrentUser(user) {
  if (!user || typeof user !== 'object' || !validId(user.id)) {
    throw fhirError('Authentication required', 401);
  }

  let account;
  try {
    account = await User.findById(String(user.id)).select('_id role patient isActive').lean();
  } catch (_) {
    throw fhirError('Unable to verify authenticated user', 503);
  }
  if (!account || account.isActive !== true) throw fhirError('Authentication required', 401);

  return {
    id: String(account._id),
    role: account.role,
    ...(account.patient ? { patient: String(account.patient) } : {})
  };
}

async function authorize(user, patientId, encounterId) {
  let result;
  try {
    result = await authorizePatientRecordAccess(user, String(patientId), encounterId ? String(encounterId) : undefined, FHIR_ACCESS_REASON);
  } catch (_) {
    // The access service writes AccessLog and fails closed when its audit write fails.
    throw fhirError('Unable to authorize or audit FHIR resource access', 503);
  }
  return result.allowed === true;
}

async function authorizePatientResource(user, patientId) {
  if (user.role !== 'doctor') return authorize(user, patientId);

  // Patient itself has no encounter link. Provide a real patient encounter as
  // context so the existing assigned-visit and patient-consent checks apply.
  let assignedEncounter;
  let latestEncounter;
  try {
    [assignedEncounter, latestEncounter] = await Promise.all([
      Encounter.findOne({ patient: patientId, assignedDoctor: user.id }).select('_id').lean(),
      Encounter.findOne({ patient: patientId }).select('_id').sort({ openedAt: -1, _id: -1 }).lean()
    ]);
  } catch (_) {
    throw fhirError('Unable to verify FHIR resource access', 503);
  }

  const candidates = [];
  if (assignedEncounter?._id) candidates.push(assignedEncounter._id);
  if (latestEncounter?._id && !candidates.some((id) => String(id) === String(latestEncounter._id))) {
    candidates.push(latestEncounter._id);
  }
  for (const encounterId of candidates) {
    if (await authorize(user, patientId, encounterId)) return true;
  }

  // The existing policy permits a break-glass authorization without an encounter.
  return authorize(user, patientId);
}

function isoDate(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return undefined;
  return value.toISOString();
}

function fhirDate(value) {
  const date = isoDate(value);
  return date ? date.slice(0, 10) : undefined;
}

function patientResource(patient) {
  const given = [patient.firstName, patient.fatherName, patient.grandfatherName].filter(Boolean);
  return {
    resourceType: 'Patient',
    id: String(patient._id),
    identifier: [{ type: { text: 'Medical record number' }, value: patient.mrn }],
    name: [{ text: given.join(' '), given }],
    gender: patient.sex,
    ...(fhirDate(patient.dateOfBirth) ? { birthDate: fhirDate(patient.dateOfBirth) } : {}),
    ...(patient.phone ? { telecom: [{ system: 'phone', value: patient.phone }] } : {}),
    ...(patient.district ? { address: [{ text: patient.district }] } : {}),
    ...(isoDate(patient.updatedAt) ? { meta: { lastUpdated: isoDate(patient.updatedAt) } } : {})
  };
}

function escapeNarrative(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

function encounterNarrative(encounter) {
  const fields = [
    ['Clinical notes', encounter.clinicalNotes],
    ['Examination findings', encounter.examinationFindings],
    ['Assessment', encounter.assessment],
    ['Treatment plan', encounter.treatmentPlan],
    ['Follow-up instructions', encounter.followUpInstructions]
  ].filter(([, value]) => typeof value === 'string' && value.length > 0);
  if (fields.length === 0) return undefined;
  return {
    status: 'generated',
    div: `<div xmlns="http://www.w3.org/1999/xhtml">${fields.map(([label, value]) => `<p><b>${label}:</b> ${escapeNarrative(value)}</p>`).join('')}</div>`
  };
}

const ENCOUNTER_CLASS = {
  outpatient: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'ambulatory' },
  inpatient: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'IMP', display: 'inpatient encounter' },
  emergency: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'EMER', display: 'emergency' }
};

function encounterResource(encounter) {
  return {
    resourceType: 'Encounter',
    id: String(encounter._id),
    status: encounter.status === 'closed' ? 'finished' : 'in-progress',
    class: ENCOUNTER_CLASS[encounter.visitType],
    type: [{ text: encounter.visitType }],
    subject: { reference: `Patient/${String(encounter.patient)}` },
    identifier: [{ type: { text: 'Visit number' }, value: encounter.visitNumber }],
    serviceType: { text: encounter.department },
    ...(encounter.chiefComplaint ? { reasonCode: [{ text: encounter.chiefComplaint }] } : {}),
    ...(isoDate(encounter.openedAt) || isoDate(encounter.closedAt) ? {
      period: {
        ...(isoDate(encounter.openedAt) ? { start: isoDate(encounter.openedAt) } : {}),
        ...(isoDate(encounter.closedAt) ? { end: isoDate(encounter.closedAt) } : {})
      }
    } : {}),
    ...(encounterNarrative(encounter) ? { text: encounterNarrative(encounter) } : {}),
    ...(isoDate(encounter.updatedAt) ? { meta: { lastUpdated: isoDate(encounter.updatedAt) } } : {})
  };
}

function quantity(value, unit, code) {
  return {
    value,
    ...(unit ? { unit } : {}),
    ...(code ? { system: 'http://unitsofmeasure.org', code } : {})
  };
}

function vitalObservation(vital) {
  const components = [
    { code: { coding: [{ system: 'http://loinc.org', code: '8480-6', display: 'Systolic blood pressure' }] }, valueQuantity: quantity(vital.bloodPressure.systolic) },
    { code: { coding: [{ system: 'http://loinc.org', code: '8462-4', display: 'Diastolic blood pressure' }] }, valueQuantity: quantity(vital.bloodPressure.diastolic) },
    { code: { coding: [{ system: 'http://loinc.org', code: '8310-5', display: 'Body temperature' }] }, valueQuantity: quantity(vital.temperature, '°C', 'Cel') },
    { code: { coding: [{ system: 'http://loinc.org', code: '8867-4', display: 'Heart rate' }] }, valueQuantity: quantity(vital.pulse, 'beats/min', '/min') },
    { code: { coding: [{ system: 'http://loinc.org', code: '29463-7', display: 'Body weight' }] }, valueQuantity: quantity(vital.weight, 'kg', 'kg') }
  ];
  if (vital.respiratoryRate !== undefined) components.push({ code: { coding: [{ system: 'http://loinc.org', code: '9279-1', display: 'Respiratory rate' }] }, valueQuantity: quantity(vital.respiratoryRate, 'breaths/min', '/min') });
  if (vital.height !== undefined) components.push({ code: { coding: [{ system: 'http://loinc.org', code: '8302-2', display: 'Body height' }] }, valueQuantity: quantity(vital.height, 'cm', 'cm') });
  if (vital.oxygenSaturation !== undefined) components.push({ code: { coding: [{ system: 'http://loinc.org', code: '59408-5', display: 'Oxygen saturation in Arterial blood' }] }, valueQuantity: quantity(vital.oxygenSaturation, '%', '%') });

  return {
    resourceType: 'Observation',
    id: String(vital._id),
    status: 'final',
    category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] }],
    code: { coding: [{ system: 'http://loinc.org', code: '85354-9', display: 'Blood pressure panel' }] },
    subject: { reference: `Patient/${String(vital.patient)}` },
    encounter: { reference: `Encounter/${String(vital.encounter)}` },
    ...(isoDate(vital.recordedAt) ? { effectiveDateTime: isoDate(vital.recordedAt) } : {}),
    component: components
  };
}

function labObservation(result, order) {
  const resource = {
    resourceType: 'Observation',
    id: String(result._id),
    status: order.status === 'completed' ? 'final' : 'preliminary',
    category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory' }] }],
    code: { text: result.componentName || order.testName },
    subject: { reference: `Patient/${String(result.patient)}` },
    encounter: { reference: `Encounter/${String(order.encounter)}` },
    ...(isoDate(result.resultedAt) ? { effectiveDateTime: isoDate(result.resultedAt) } : {})
  };

  if (result.resultType === 'numeric') {
    resource.valueQuantity = quantity(result.numericValue, result.unit);
    if (result.referenceRange && (result.referenceRange.minimum != null || result.referenceRange.maximum != null)) {
      resource.referenceRange = [{
        ...(result.referenceRange.minimum != null ? { low: quantity(result.referenceRange.minimum, result.unit) } : {}),
        ...(result.referenceRange.maximum != null ? { high: quantity(result.referenceRange.maximum, result.unit) } : {})
      }];
    }
  } else if (result.resultType === 'text') {
    resource.valueString = result.textValue;
  }

  const interpretations = {
    normal: { code: 'N', display: 'Normal' },
    high: { code: 'H', display: 'High' },
    low: { code: 'L', display: 'Low' }
  };
  if (interpretations[result.flag]) {
    resource.interpretation = [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation', ...interpretations[result.flag] }] }];
  }
  return resource;
}

const PRESCRIPTION_STATUS = {
  pending: 'active',
  partially_dispensed: 'active',
  dispensed: 'completed',
  cancelled: 'cancelled'
};

function medicationRequestResource(prescription) {
  return {
    resourceType: 'MedicationRequest',
    id: String(prescription._id),
    status: PRESCRIPTION_STATUS[prescription.status],
    intent: 'order',
    medicationCodeableConcept: { text: prescription.drugName },
    subject: { reference: `Patient/${String(prescription.patient)}` },
    encounter: { reference: `Encounter/${String(prescription.encounter)}` },
    authoredOn: isoDate(prescription.prescribedAt),
    dosageInstruction: [{
      text: `${prescription.dose}; ${prescription.frequency}; ${prescription.duration} days`,
      route: { text: prescription.route },
      timing: { repeat: { boundsDuration: { value: prescription.duration, unit: 'days', system: 'http://unitsofmeasure.org', code: 'd' } } },
      ...(prescription.instructions ? { patientInstruction: prescription.instructions } : {})
    }],
    dispenseRequest: { quantity: { value: prescription.quantity } }
  };
}

async function findOne(model, id, projection, label) {
  try {
    return await model.findById(String(id)).select(projection).lean();
  } catch (_) {
    throw fhirError(`Unable to retrieve FHIR ${label}`, 503);
  }
}

async function readPatient(id, user) {
  if (!await authorizePatientResource(user, id)) throw fhirError('FHIR resource not found', 404);
  const patient = await findOne(Patient, id, SAFE_PATIENT_FIELDS, 'Patient');
  if (!patient) throw fhirError('FHIR resource not found', 404);
  return patientResource(patient);
}

async function readEncounter(id, user) {
  const encounter = await findOne(Encounter, id, SAFE_ENCOUNTER_FIELDS, 'Encounter');
  if (!encounter) throw fhirError('FHIR resource not found', 404);
  if (!await authorize(user, encounter.patient, encounter._id)) throw fhirError('FHIR resource not found', 404);
  return encounterResource(encounter);
}

async function readVital(id, user, loadedVital) {
  const vital = loadedVital || await findOne(Vital, id, SAFE_VITAL_FIELDS, 'Observation');
  if (!vital) return null;
  let encounter;
  try { encounter = await Encounter.findById(String(vital.encounter)).select('_id patient').lean(); } catch (_) { throw fhirError('Unable to verify FHIR resource relationship', 503); }
  if (!encounter || String(encounter.patient) !== String(vital.patient)) {
    await authorize(user, vital.patient, vital.encounter);
    throw fhirError('FHIR resource not found', 404);
  }
  if (!await authorize(user, vital.patient, vital.encounter)) throw fhirError('FHIR resource not found', 404);
  return vitalObservation(vital);
}

async function readLabResult(id, user, loadedResult) {
  const result = loadedResult || await findOne(LabResult, id, SAFE_LAB_RESULT_FIELDS, 'Observation');
  if (!result) return null;

  let order;
  let encounter;
  try {
    order = await LabOrder.findById(String(result.labOrder)).select(SAFE_LAB_ORDER_FIELDS).lean();
    encounter = order ? await Encounter.findById(String(order.encounter)).select('_id patient').lean() : null;
  } catch (_) {
    throw fhirError('Unable to verify FHIR resource relationship', 503);
  }

  if (!order || !encounter || String(order.patient) !== String(result.patient) || String(encounter.patient) !== String(result.patient)) {
    await authorize(user, result.patient, order?.encounter || result.labOrder);
    throw fhirError('FHIR resource not found', 404);
  }
  if (!await authorize(user, result.patient, encounter._id)) throw fhirError('FHIR resource not found', 404);
  return labObservation(result, order);
}

async function readObservation(id, user) {
  // ObjectIds are collection-local; if an unlikely collision exists, prefer
  // neither record because an ambiguous reference must not expose either one.
  const vital = await findOne(Vital, id, SAFE_VITAL_FIELDS, 'Observation');
  const result = await findOne(LabResult, id, SAFE_LAB_RESULT_FIELDS, 'Observation');
  if (vital && result) throw fhirError('FHIR resource not found', 404);
  if (vital) return readVital(id, user, vital);
  if (result) return readLabResult(id, user, result);
  throw fhirError('FHIR resource not found', 404);
}

async function readMedicationRequest(id, user) {
  const prescription = await findOne(Prescription, id, SAFE_PRESCRIPTION_FIELDS, 'MedicationRequest');
  if (!prescription) throw fhirError('FHIR resource not found', 404);
  let encounter;
  try { encounter = await Encounter.findById(String(prescription.encounter)).select('_id patient').lean(); } catch (_) { throw fhirError('Unable to verify FHIR resource relationship', 503); }
  if (!encounter || String(encounter.patient) !== String(prescription.patient)) {
    await authorize(user, prescription.patient, prescription.encounter);
    throw fhirError('FHIR resource not found', 404);
  }
  if (!await authorize(user, prescription.patient, encounter._id)) throw fhirError('FHIR resource not found', 404);
  return medicationRequestResource(prescription);
}

async function getFhirResource(resourceType, id, user) {
  if (!validId(id)) throw fhirError('A valid resource ID is required', 400);
  const currentUser = await requireCurrentUser(user);
  const supported = {
    Patient: readPatient,
    Encounter: readEncounter,
    Observation: readObservation,
    MedicationRequest: readMedicationRequest
  };
  const reader = supported[resourceType];
  if (!reader) throw fhirError('FHIR resource type is not supported', 404);
  return reader(String(id), currentUser);
}

module.exports = { getFhirResource };
