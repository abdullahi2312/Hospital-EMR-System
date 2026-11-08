'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const mongoose = require('mongoose');

process.env.JWT_SECRET = 'department-route-test-secret-with-enough-entropy';
process.env.JWT_EXPIRES_IN = '1h';

const servicePath = require.resolve('../services/department.service');
const previousService = require.cache[servicePath];
const calls = [];
const fakeModule = new Module(servicePath);
fakeModule.filename = servicePath;
fakeModule.loaded = true;
fakeModule.exports = {
  async listActiveDepartments() { calls.push({ method: 'list' }); return [{ id: 'dep-1', name: 'Outpatient', code: 'OPD' }]; },
  async createDepartment(input, user) { calls.push({ method: 'create', input, user }); return { id: 'dep-2', name: input.name, code: input.code, isActive: true }; }
};
require.cache[servicePath] = fakeModule;

const roles = ['admin', 'receptionist', 'doctor', 'lab_technician', 'pharmacist', 'patient'];
const ids = Object.fromEntries(roles.map((role) => [role, new mongoose.Types.ObjectId()]));
const users = new Map(roles.map((role) => [String(ids[role]), { _id: ids[role], role, isActive: true, fullName: role, username: role }]));
const User = require('../models/User');
const originalFindById = User.findById;
User.findById = (id) => ({ select() { return this; }, lean: async () => users.get(String(id)) || null });
const { generateToken } = require('../utils/token');
const app = require('../app');
const server = http.createServer(app);

function token(role) { return generateToken({ id: String(ids[role]), role: 'patient' }); }
function request(port, method, path, role, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: {
      authorization: `Bearer ${token(role)}`,
      ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {})
    } }, (res) => { let text = ''; res.on('data', (chunk) => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) })); });
    req.on('error', reject); if (payload) req.write(payload); req.end();
  });
}

test.before(async () => { await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); });
test.after(async () => {
  await new Promise((resolve) => server.close(resolve)); User.findById = originalFindById;
  if (previousService) require.cache[servicePath] = previousService; else delete require.cache[servicePath];
});
test.beforeEach(() => { calls.length = 0; });

test('active department lookup is authenticated and available only to receptionist/admin', async () => {
  const port = server.address().port;
  assert.equal((await request(port, 'GET', '/api/departments', 'patient')).status, 403);
  assert.equal((await request(port, 'GET', '/api/departments', 'doctor')).status, 403);
  const result = await request(port, 'GET', '/api/departments', 'receptionist');
  assert.equal(result.status, 200); assert.equal(result.body.data.departments[0].code, 'OPD');
  assert.equal(calls.length, 1);
});

test('only admin can create departments; creation delegates to audited service', async () => {
  const port = server.address().port;
  const payload = { name: 'Outpatient', code: 'OPD' };
  assert.equal((await request(port, 'POST', '/api/departments', 'receptionist', payload)).status, 403);
  const result = await request(port, 'POST', '/api/departments', 'admin', payload);
  assert.equal(result.status, 201); assert.equal(result.body.data.department.code, 'OPD');
  assert.equal(calls[0].method, 'create'); assert.equal(calls[0].user.role, 'admin');
});
