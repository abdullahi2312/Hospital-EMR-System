import { api } from './httpClient.js';

export const receptionApi = {
  registerPatient: (payload) => api.post('/patients', payload),
  patients: (params = {}) => api.get('/patients', { params }),
  patient: (id) => api.get(`/patients/${encodeURIComponent(id)}`),
  departments: () => api.get('/departments'),
  createEncounter: (payload) => api.post('/encounters', payload)
};
