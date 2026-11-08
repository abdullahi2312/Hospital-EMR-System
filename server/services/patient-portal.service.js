'use strict';

const mongoose = require('mongoose');
const fs = require('node:fs');
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const User = require('../models/User');
const Patient = require('../models/Patient');
const Encounter = require('../models/Encounter');
const LabResult = require('../models/LabResult');
const LabOrder = require('../models/LabOrder');
const Prescription = require('../models/Prescription');
const { authorizePatientRecordAccess } = require('./patient-access.service');
const { listEncounters } = require('./encounter.service');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_PAGE = 1000000;

function portalError(message, status = 400) {
  const error = new Error(message);
  error.name = 'PatientPortalServiceError';
  error.status = status;
  error.statusCode = status;
  return error;
}

function positiveInteger(value, name, fallback, maximum) {
  if (value === undefined) return fallback;
  const source = typeof value === 'number' ? String(value) : value;
  if (typeof source !== 'string' || !/^\d+$/.test(source)) throw portalError(`${name} must be a positive whole number`);
  const parsed = Number(source);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw portalError(`${name} must be between 1 and ${maximum}`);
  return parsed;
}

async function listPatientPortalDoctors(options, user) {
  if (!user || !mongoose.isObjectIdOrHexString(user.id)) throw portalError('Authentication required', 401);
  let account;
  try {
    account = await User.findById(String(user.id)).select('_id role patient isActive').lean();
  } catch (_) {
    throw portalError('Unable to verify patient portal account', 500);
  }
  if (!account || account.isActive !== true) throw portalError('Authentication required', 401);
  if (account.role !== 'patient' || !mongoose.isObjectIdOrHexString(account.patient)) {
    throw portalError('A linked active patient account is required', 403);
  }
  try {
    if (!await Patient.exists({ _id: account.patient })) throw portalError('Linked patient record was not found', 403);
  } catch (error) {
    if (error.name === 'PatientPortalServiceError') throw error;
    throw portalError('Unable to verify linked patient record', 500);
  }

  const query = options || {};
  if (!query || typeof query !== 'object' || Array.isArray(query) || Object.keys(query).some((key) => !['page', 'limit', 'search'].includes(key))) {
    throw portalError('Doctor directory options contain unsupported fields');
  }
  const page = positiveInteger(query.page, 'Page', 1, MAX_PAGE);
  const limit = positiveInteger(query.limit, 'Limit', DEFAULT_LIMIT, MAX_LIMIT);
  if (query.search !== undefined && (typeof query.search !== 'string' || query.search.normalize('NFKC').trim().length > 100)) {
    throw portalError('Doctor name search must be text of at most 100 characters');
  }
  const search = typeof query.search === 'string' ? query.search.normalize('NFKC').trim() : '';
  const filter = { role: 'doctor', isActive: true };
  if (search) filter.fullName = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
  const skip = (page - 1) * limit;
  let doctors;
  let total;
  try {
    [doctors, total] = await Promise.all([
      User.find(filter).select('_id fullName').sort({ fullName: 1, _id: 1 }).skip(skip).limit(limit).lean(),
      User.countDocuments(filter)
    ]);
  } catch (_) {
    throw portalError('Unable to retrieve the consent doctor directory', 500);
  }
  return {
    doctors: doctors.map((doctor) => ({ id: doctor._id.toString(), fullName: doctor.fullName })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
  };
}

async function getPatientContext(user) {
  if (!user || !mongoose.isObjectIdOrHexString(user.id)) throw portalError('Authentication required', 401);
  let account;
  try {
    account = await User.findById(String(user.id)).select('_id role patient isActive').lean();
  } catch (_) {
    throw portalError('Unable to verify patient portal account', 500);
  }
  if (!account || account.isActive !== true) throw portalError('Authentication required', 401);
  if (account.role !== 'patient' || !mongoose.isObjectIdOrHexString(account.patient)) {
    throw portalError('A linked active patient account is required', 403);
  }
  let patient;
  try {
    patient = await Patient.findById(String(account.patient))
      .select('_id mrn firstName fatherName grandfatherName sex dateOfBirth estimatedAge phone district createdAt')
      .lean();
  } catch (_) {
    throw portalError('Unable to retrieve the linked patient profile', 500);
  }
  if (!patient) throw portalError('Linked patient record was not found', 403);

  let decision;
  try {
    decision = await authorizePatientRecordAccess({ id: account._id.toString(), role: 'patient', patient: patient._id.toString() }, patient._id.toString());
  } catch (_) {
    throw portalError('Unable to authorize or audit patient portal access', 500);
  }
  if (!decision.allowed) throw portalError('Patient record access is not permitted', decision.statusCode || 403);
  return { account, patient };
}

async function getPatientPortalProfile(user) {
  const { patient } = await getPatientContext(user);
  return {
    id: patient._id.toString(),
    mrn: patient.mrn,
    name: [patient.firstName, patient.fatherName, patient.grandfatherName].filter(Boolean).join(' '),
    sex: patient.sex,
    ...(patient.dateOfBirth ? { dateOfBirth: patient.dateOfBirth } : {}),
    ...(patient.estimatedAge != null ? { estimatedAge: patient.estimatedAge } : {}),
    ...(patient.phone ? { phone: patient.phone } : {}),
    ...(patient.district ? { district: patient.district } : {}),
    registeredAt: patient.createdAt
  };
}

async function listPatientPortalLabResults(options, user) {
  const { patient } = await getPatientContext(user);
  const query = options || {};
  if (!query || typeof query !== 'object' || Array.isArray(query) || Object.keys(query).some((key) => !['page', 'limit'].includes(key))) {
    throw portalError('Laboratory result options contain unsupported fields');
  }
  const page = positiveInteger(query.page, 'Page', 1, MAX_PAGE);
  const limit = positiveInteger(query.limit, 'Limit', DEFAULT_LIMIT, MAX_LIMIT);
  const skip = (page - 1) * limit;
  let result;
  try {
    [result] = await LabResult.aggregate([
      { $match: { patient: patient._id } },
      {
        $lookup: {
          from: LabOrder.collection.name,
          let: { orderId: '$labOrder', patientId: '$patient' },
          pipeline: [
            { $match: { $expr: { $and: [{ $eq: ['$_id', '$$orderId'] }, { $eq: ['$patient', '$$patientId'] }, { $eq: ['$status', 'completed'] }] } } },
            { $project: { _id: 1, patient: 1, encounter: 1, testName: 1, status: 1 } }
          ],
          as: 'authorizedOrder'
        }
      },
      { $unwind: '$authorizedOrder' },
      {
        $lookup: {
          from: Encounter.collection.name,
          let: { encounterId: '$authorizedOrder.encounter', patientId: '$patient' },
          pipeline: [
            { $match: { $expr: { $and: [{ $eq: ['$_id', '$$encounterId'] }, { $eq: ['$patient', '$$patientId'] }] } } },
            { $project: { _id: 1, visitNumber: 1, openedAt: 1 } }
          ],
          as: 'authorizedEncounter'
        }
      },
      { $unwind: '$authorizedEncounter' },
      { $sort: { resultedAt: -1, _id: -1 } },
      {
        $facet: {
          results: [
            { $skip: skip },
            { $limit: limit },
            {
              $project: {
                _id: 0,
                id: { $toString: '$_id' },
                encounter: { id: { $toString: '$authorizedEncounter._id' }, visitNumber: '$authorizedEncounter.visitNumber', openedAt: '$authorizedEncounter.openedAt' },
                testName: '$authorizedOrder.testName',
                componentId: 1,
                componentName: 1,
                resultType: 1,
                numericValue: 1,
                textValue: 1,
                unit: 1,
                referenceRange: 1,
                flag: 1,
                resultedAt: 1
              }
            }
          ],
          count: [{ $count: 'total' }]
        }
      }
    ]);
  } catch (_) {
    throw portalError('Unable to retrieve patient laboratory results', 500);
  }
  const total = result?.count?.[0]?.total || 0;
  return { results: result?.results || [], pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

async function listPatientPortalPrescriptions(options, user) {
  const { patient } = await getPatientContext(user);
  const query = options || {};
  if (!query || typeof query !== 'object' || Array.isArray(query) || Object.keys(query).some((key) => !['page', 'limit'].includes(key))) {
    throw portalError('Prescription options contain unsupported fields');
  }
  const page = positiveInteger(query.page, 'Page', 1, MAX_PAGE);
  const limit = positiveInteger(query.limit, 'Limit', DEFAULT_LIMIT, MAX_LIMIT);
  const skip = (page - 1) * limit;
  let result;
  try {
    [result] = await Prescription.aggregate([
      { $match: { patient: patient._id } },
      {
        $lookup: {
          from: Encounter.collection.name,
          let: { encounterId: '$encounter', patientId: '$patient' },
          pipeline: [
            { $match: { $expr: { $and: [{ $eq: ['$_id', '$$encounterId'] }, { $eq: ['$patient', '$$patientId'] }] } } },
            { $project: { _id: 1, visitNumber: 1, openedAt: 1 } }
          ],
          as: 'authorizedEncounter'
        }
      },
      { $unwind: '$authorizedEncounter' },
      { $sort: { prescribedAt: -1, _id: -1 } },
      {
        $facet: {
          prescriptions: [
            { $skip: skip },
            { $limit: limit },
            {
              $project: {
                _id: 0,
                id: { $toString: '$_id' },
                encounter: { id: { $toString: '$authorizedEncounter._id' }, visitNumber: '$authorizedEncounter.visitNumber', openedAt: '$authorizedEncounter.openedAt' },
                drugName: 1,
                dose: 1,
                route: 1,
                frequency: 1,
                duration: 1,
                quantity: 1,
                status: 1,
                prescribedAt: 1
              }
            }
          ],
          count: [{ $count: 'total' }]
        }
      }
    ]);
  } catch (_) {
    throw portalError('Unable to retrieve patient prescription history', 500);
  }
  const total = result?.count?.[0]?.total || 0;
  return { prescriptions: result?.prescriptions || [], pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

function wrapPdfLine(value, maximum = 92) {
  const points = Array.from(String(value ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, ' '));
  if (points.length <= maximum) return [points.join('')];
  const output = [];
  for (let index = 0; index < points.length; index += maximum) output.push(points.slice(index, index + maximum).join(''));
  return output;
}

function unicodeFontBuffers() {
  try {
    return [
      fs.readFileSync(require.resolve('@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff')),
      fs.readFileSync(require.resolve('@fontsource/noto-sans/files/noto-sans-latin-ext-400-normal.woff'))
    ];
  } catch (_) {
    throw portalError('Unicode patient-summary font assets are unavailable', 500);
  }
}

function drawUnicodeLine(page, line, fonts, y) {
  const [base, extended] = fonts;
  const segments = [];
  for (const character of Array.from(line)) {
    const codePoint = character.codePointAt(0);
    const font = base.characterSet.includes(codePoint) ? base : extended.characterSet.includes(codePoint) ? extended : base;
    const outputCharacter = font.characterSet.includes(codePoint) ? character : '?';
    const previous = segments[segments.length - 1];
    if (previous?.font === font) previous.text += outputCharacter;
    else segments.push({ font, text: outputCharacter });
  }
  let x = 50;
  for (const segment of segments) {
    page.drawText(segment.text, { x, y, size: 10, font: segment.font.pdfFont, color: rgb(0.12, 0.16, 0.22) });
    x += segment.font.pdfFont.widthOfTextAtSize(segment.text, 10);
  }
}

async function makeSummaryPdf(lines) {
  const wrapped = lines.flatMap((line) => wrapPdfLine(line));
  const pageLines = [];
  for (let index = 0; index < wrapped.length; index += 50) pageLines.push(wrapped.slice(index, index + 50));
  if (!pageLines.length) pageLines.push(['No summary information available.']);

  const document = await PDFDocument.create({ updateMetadata: false });
  document.registerFontkit(fontkit);
  const fontBuffers = unicodeFontBuffers();
  const fonts = await Promise.all(fontBuffers.map(async (fontBuffer) => {
    const pdfFont = await document.embedFont(fontBuffer, { subset: true });
    const metrics = fontkit.create(fontBuffer);
    return { pdfFont, characterSet: metrics.characterSet };
  }));
  document.setTitle('Hospital EMR - Patient Summary');
  document.setAuthor('Hospital EMR');
  document.setSubject('Patient-owned visit, completed laboratory, and prescription summary');
  document.setCreator('Hospital EMR Patient Portal');

  for (const linesForPage of pageLines) {
    const page = document.addPage([612, 842]);
    linesForPage.forEach((line, index) => drawUnicodeLine(page, line, fonts, 790 - index * 14));
  }
  return Buffer.from(await document.save({ useObjectStreams: false }));
}

async function buildPatientSummaryPdf(user) {
  const profile = await getPatientPortalProfile(user);
  const [encounters, labs, prescriptions] = await Promise.all([
    listEncounters({ page: 1, limit: 100 }, user),
    listPatientPortalLabResults({ page: 1, limit: 100 }, user),
    listPatientPortalPrescriptions({ page: 1, limit: 100 }, user)
  ]);
  const lines = [
    'Hospital EMR - Patient Summary',
    `Generated: ${new Date().toISOString()}`,
    `Patient: ${profile.name}`,
    `MRN: ${profile.mrn}`,
    `Sex: ${profile.sex}`,
    profile.dateOfBirth ? `Date of birth: ${new Date(profile.dateOfBirth).toISOString().slice(0, 10)}` : `Estimated age: ${profile.estimatedAge ?? 'Not recorded'}`,
    '',
    'Visit history'
  ];
  encounters.encounters.forEach((visit) => lines.push(`${visit.visitNumber} | ${visit.visitType} | ${visit.department} | ${visit.status} | ${new Date(visit.openedAt).toISOString().slice(0, 10)}`));
  lines.push('', 'Laboratory results');
  labs.results.forEach((result) => lines.push(`${result.encounter?.visitNumber || ''} | ${result.testName}${result.componentName ? ` (${result.componentName})` : ''} | ${result.resultType === 'numeric' ? `${result.numericValue} ${result.unit || ''}` : result.textValue || ''} | ${result.flag} | ${new Date(result.resultedAt).toISOString().slice(0, 10)}`));
  lines.push('', 'Prescriptions');
  prescriptions.prescriptions.forEach((item) => lines.push(`${item.encounter?.visitNumber || ''} | ${item.drugName} ${item.dose} | ${item.route} | ${item.frequency} | ${item.duration} days | ${item.quantity} | ${item.status}`));
  if (encounters.pagination.total > 100 || labs.pagination.total > 100 || prescriptions.pagination.total > 100) {
    lines.push('', 'This PDF includes up to the 100 most recent records in each section.');
  }
  return makeSummaryPdf(lines);
}

module.exports = {
  listPatientPortalDoctors,
  getPatientPortalProfile,
  listPatientPortalLabResults,
  listPatientPortalPrescriptions,
  buildPatientSummaryPdf,
  makeSummaryPdf
};
