'use strict';

const {
  listPatientPortalDoctors,
  getPatientPortalProfile,
  listPatientPortalLabResults,
  listPatientPortalPrescriptions,
  buildPatientSummaryPdf
} = require('../services/patient-portal.service');

function badRequest(res, message) {
  return res.status(400).json({ success: false, message, data: null });
}

function handle(error, next) {
  if (error?.name === 'PatientPortalServiceError') return next(error);
  return next(error);
}

async function profile(req, res, next) {
  if (Object.keys(req.query || {}).length) return badRequest(res, 'Profile does not accept query parameters');
  try { return res.status(200).json({ success: true, message: 'Patient profile retrieved successfully', data: await getPatientPortalProfile(req.user) }); }
  catch (error) { return handle(error, next); }
}

function validPaginationQuery(query) {
  return Object.keys(query || {}).every((key) => ['page', 'limit'].includes(key));
}

async function doctors(req, res, next) {
  if (Object.keys(req.query || {}).some((key) => !['page', 'limit', 'search'].includes(key))) {
    return badRequest(res, 'Query contains unsupported fields');
  }
  try { return res.status(200).json({ success: true, message: 'Consent doctor directory retrieved successfully', data: await listPatientPortalDoctors(req.query, req.user) }); }
  catch (error) { return handle(error, next); }
}

async function labResults(req, res, next) {
  if (!validPaginationQuery(req.query)) return badRequest(res, 'Query contains unsupported fields');
  try { return res.status(200).json({ success: true, message: 'Patient laboratory results retrieved successfully', data: await listPatientPortalLabResults(req.query, req.user) }); }
  catch (error) { return handle(error, next); }
}

async function prescriptions(req, res, next) {
  if (!validPaginationQuery(req.query)) return badRequest(res, 'Query contains unsupported fields');
  try { return res.status(200).json({ success: true, message: 'Patient prescriptions retrieved successfully', data: await listPatientPortalPrescriptions(req.query, req.user) }); }
  catch (error) { return handle(error, next); }
}

async function summaryPdf(req, res, next) {
  if (Object.keys(req.query || {}).length) return badRequest(res, 'Summary download does not accept query parameters');
  try {
    const pdf = await buildPatientSummaryPdf(req.user);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="patient-summary.pdf"', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    return res.status(200).send(pdf);
  } catch (error) { return handle(error, next); }
}

module.exports = { doctors, profile, labResults, prescriptions, summaryPdf };
