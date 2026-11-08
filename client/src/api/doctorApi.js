import { api } from './httpClient.js';

export const doctorApi = {
  encounters: (params = {}) => api.get('/encounters', { params }),
  encounter: (id) => api.get(`/encounters/${encodeURIComponent(id)}`),
  timeline: (patientId, params = {}) => api.get(`/patients/${encodeURIComponent(patientId)}/timeline`, { params }),
  vitals: (encounterId) => api.get(`/encounters/${encodeURIComponent(encounterId)}/vitals`),
  recordVitals: (encounterId, payload) => api.post(`/encounters/${encodeURIComponent(encounterId)}/vitals`, payload),
  diagnoses: (encounterId) => api.get(`/encounters/${encodeURIComponent(encounterId)}/diagnoses`),
  addDiagnosis: (encounterId, payload) => api.post(`/encounters/${encodeURIComponent(encounterId)}/diagnoses`, payload),
  updateNotes: (encounterId, payload) => api.patch(`/encounters/${encodeURIComponent(encounterId)}/notes`, payload),
  prescription: (encounterId, payload) => api.post(`/encounters/${encodeURIComponent(encounterId)}/prescriptions`, payload),
  closeEncounter: (encounterId) => api.patch(`/encounters/${encodeURIComponent(encounterId)}/close`),
  breakGlass: (patientId, payload) => api.post(`/patients/${encodeURIComponent(patientId)}/break-glass`, payload)
};
