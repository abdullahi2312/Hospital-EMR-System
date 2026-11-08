import { api } from './httpClient.js';

export const patientLoginRequest = (credentials) => api.post('/auth/patient-login', credentials);
export const getPortalDoctors = (params) => api.get('/patient-portal/doctors', { params });
export const getPortalProfile = () => api.get('/patient-portal/profile');
export const getPortalLabResults = (params) => api.get('/patient-portal/lab-results', { params });
export const getPortalPrescriptions = (params) => api.get('/patient-portal/prescriptions', { params });
export const getPortalSummaryPdf = () => api.get('/patient-portal/summary.pdf', { responseType: 'blob' });
export const getPortalVisits = (params) => api.get('/encounters', { params });
export const getPortalConsents = () => api.get('/consents');
export const grantPortalConsent = (payload) => api.post('/consents', payload);
export const revokePortalConsent = (id) => api.patch(`/consents/${encodeURIComponent(id)}/revoke`);
