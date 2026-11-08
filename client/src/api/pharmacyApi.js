import { api } from './httpClient.js';

export const pharmacyApi = {
  pendingPrescriptions: (params = {}) => api.get('/pharmacy/prescriptions/pending', { params }),
  prescription: (prescriptionId) => api.get(`/pharmacy/prescriptions/${encodeURIComponent(prescriptionId)}`),
  inventory: (medicationId) => api.get(`/pharmacy/inventory/${encodeURIComponent(medicationId)}`),
  dispense: (prescriptionId, payload) => api.post(`/pharmacy/prescriptions/${encodeURIComponent(prescriptionId)}/dispense`, payload)
};
