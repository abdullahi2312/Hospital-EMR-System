import { api } from './httpClient.js';

export const adminApi = {
  analytics: (params = {}) => api.get('/admin/analytics', { params }),
  users: (params = {}) => api.get('/admin/users', { params }),
  user: (id) => api.get(`/admin/users/${encodeURIComponent(id)}`),
  createUser: (payload) => api.post('/admin/users', payload),
  setUserStatus: (id, payload) => api.patch(`/admin/users/${encodeURIComponent(id)}/status`, payload),
  patients: (params = {}) => api.get('/patients', { params }),
  patient: (id) => api.get(`/patients/${encodeURIComponent(id)}`),
  auditLogs: (params = {}) => api.get('/admin/audit-logs', { params }),
  accessLogs: (params = {}) => api.get('/admin/access-logs', { params }),
  departments: () => api.get('/departments'),
  createDepartment: (payload) => api.post('/departments', payload)
};

export function responseData(response) {
  return response.data?.data;
}
