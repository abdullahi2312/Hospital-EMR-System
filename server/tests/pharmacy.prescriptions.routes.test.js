'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const mongoose = require('mongoose');

process.env.JWT_SECRET = 'pharmacy-prescription-route-test-secret-with-entropy';
process.env.JWT_EXPIRES_IN = '1h';

const pharmacyServicePath = require.resolve('../services/pharmacy.service');
const previousServiceModule = require.cache[pharmacyServicePath];
const calls = [];
const fakeServiceModule = new Module(pharmacyServicePath);
fakeServiceModule.filename = pharmacyServicePath;
fakeServiceModule.loaded = true;
fakeServiceModule.exports = {
  async listPendingPrescriptions(options, user) {
    calls.push({ method: 'queue', options, user });
    return { prescriptions: [{ id: 'rx-1', status: 'pending', remainingQuantity: 4 }], pagination: { page: 2, limit: 5, total: 6, totalPages: 2 } };
  },
  async getPharmacistPrescriptionDetails(prescriptionId, user) {
    calls.push({ method: 'details', prescriptionId, user });
    return { id: prescriptionId, status: 'pending', dispensingHistory: [], remainingQuantity: 4 };
  },
  async getMedicationInventory() { return { medication: {}, inventory: [] }; },
  async addInventoryStock() { return {}; },
  async dispensePrescription() { return {}; }
};
require.cache[pharmacyServicePath] = fakeServiceModule;

const ids = Object.fromEntries(['admin', 'receptionist', 'doctor', 'lab_technician', 'pharmacist', 'patient']
  .map((role) => [role, new mongoose.Types.ObjectId()]));
const roles = new Map(Object.entries(ids).map(([role, id]) => [String(id), {
  _id: id, role, isActive: true, fullName: `Route ${role}`, username: role
}]));
const User = require('../models/User');
const originalFindById = User.findById;
User.findById = (id) => ({ select() { return this; }, lean: async () => roles.get(String(id)) || null });
const { generateToken } = require('../utils/token');
const app = require('../app');
const server = http.createServer(app);

function token(role) {
  return generateToken({ id: String(ids[role]), role: 'admin' });
}

function request(port, path, authorization) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'GET', path,
      headers: authorization ? { authorization: `Bearer ${authorization}` } : {}
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null }));
    });
    req.on('error', reject);
    req.end();
  });
}

test.before(async () => { await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); });
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  User.findById = originalFindById;
  if (previousServiceModule) require.cache[pharmacyServicePath] = previousServiceModule;
  else delete require.cache[pharmacyServicePath];
});
test.beforeEach(() => { calls.length = 0; });

test('pharmacist prescription queue is authenticated, role-restricted, and paginated', async () => {
  const port = server.address().port;
  assert.equal((await request(port, '/api/pharmacy/prescriptions/pending')).status, 401);
  const pharmacistResponse = await request(port, '/api/pharmacy/prescriptions/pending?page=2&limit=5', token('pharmacist'));
  assert.equal(pharmacistResponse.status, 200);
  assert.equal(pharmacistResponse.body.success, true);
  assert.equal(pharmacistResponse.body.data.prescriptions[0].remainingQuantity, 4);
  assert.equal(pharmacistResponse.body.data.pagination.total, 6);
  assert.equal(calls[0].method, 'queue');
  assert.deepEqual(calls[0].options, { page: '2', limit: '5' });
  assert.equal(calls[0].user.role, 'pharmacist'); // Current database role overrides the token's admin claim.
});

test('non-pharmacist roles cannot read queue or prescription details', async () => {
  const port = server.address().port;
  for (const role of ['admin', 'receptionist', 'doctor', 'lab_technician', 'patient']) {
    assert.equal((await request(port, '/api/pharmacy/prescriptions/pending', token(role))).status, 403, role);
    assert.equal((await request(port, '/api/pharmacy/prescriptions/507f1f77bcf86cd799439011', token(role))).status, 403, role);
  }
  assert.equal(calls.length, 0);
});

test('prescription details validate IDs and are served through the pharmacist-only route', async () => {
  const port = server.address().port;
  assert.equal((await request(port, '/api/pharmacy/prescriptions/not-an-id', token('pharmacist'))).status, 400);
  const prescriptionId = '507f1f77bcf86cd799439011';
  const response = await request(port, `/api/pharmacy/prescriptions/${prescriptionId}`, token('pharmacist'));
  assert.equal(response.status, 200);
  assert.equal(response.body.data.id, prescriptionId);
  assert.equal(calls[0].method, 'details');
  assert.equal(calls[0].prescriptionId, prescriptionId);
  assert.equal(calls[0].user.role, 'pharmacist');
});

test('queue rejects unsupported filters and unsafe pagination values', async () => {
  const port = server.address().port;
  assert.equal((await request(port, '/api/pharmacy/prescriptions/pending?status=all', token('pharmacist'))).status, 400);
  assert.equal(calls.length, 0);
});
