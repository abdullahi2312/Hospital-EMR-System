'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const patientService = require('../services/patient.service');
const originalRegisterPatient = patientService.registerPatient;
let registerImplementation;
patientService.registerPatient = (...args) => registerImplementation(...args);
const controller = require('../controllers/patient.controller');

test.after(() => {
  patientService.registerPatient = originalRegisterPatient;
});

function responseRecorder() {
  return {
    statusCode: null,
    body: null,
    status(statusCode) { this.statusCode = statusCode; return this; },
    json(body) { this.body = body; return this; }
  };
}

function serviceError(message, properties = {}) {
  return Object.assign(new Error(message), { name: 'PatientServiceError', status: 503, ...properties });
}

test('registration controller returns safe machine-readable config failure without partial-success claim', async () => {
  registerImplementation = async () => {
    throw serviceError('Patient idempotency protection is not configured', {
      code: 'PATIENT_IDEMPOTENCY_NOT_CONFIGURED', retrySameKey: true
    });
  };
  const res = responseRecorder();
  let forwarded;
  await controller.register({ body: { idempotencyKey: 'same-registration-key-0001' }, user: { id: 'actor' } }, res, (error) => { forwarded = error; });
  assert.equal(forwarded, undefined);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.message, 'Patient idempotency protection is not configured');
  assert.deepEqual(res.body.data, { code: 'PATIENT_IDEMPOTENCY_NOT_CONFIGURED', retrySameKey: true });
});

test('registration controller identifies recoverable partial success for same-key retry', async () => {
  registerImplementation = async () => {
    throw serviceError('Patient registration was saved, but audit logging failed.', {
      partialSuccess: true, retrySameKey: true, patientId: 'private-id'
    });
  };
  const res = responseRecorder();
  await controller.register({ body: { idempotencyKey: 'same-registration-key-0002' }, user: { id: 'actor' } }, res, () => {});
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.data.partialSuccess, true);
  assert.equal(res.body.data.retrySameKey, true);
  assert.equal(Object.hasOwn(res.body.data, 'patientId'), false);
});
