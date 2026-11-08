import axios from 'axios';
import { normalizeApiError } from './apiErrors.js';

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || '/api',
  headers: { Accept: 'application/json' },
  timeout: 15000
});

export function setSessionToken(token) {
  if (token) sessionStorage.setItem('hospital-emr-token', token);
  else sessionStorage.removeItem('hospital-emr-token');
}

export function getSessionToken() {
  return sessionStorage.getItem('hospital-emr-token');
}

api.interceptors.request.use((config) => {
  const token = getSessionToken();
  const language = localStorage.getItem('hospital-emr-language') === 'so' ? 'so' : 'en';
  config.headers.set('Accept-Language', language);
  if (token) config.headers.set('Authorization', `Bearer ${token}`);
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      setSessionToken(null);
      window.dispatchEvent(new CustomEvent('hospital-emr:unauthorized'));
    }
    error.apiError = normalizeApiError(error);
    return Promise.reject(error);
  }
);

export async function loginRequest(credentials) {
  return api.post('/auth/login', credentials);
}

export async function patientLoginRequest(credentials) {
  return api.post('/auth/patient-login', credentials);
}

export async function currentUserRequest() {
  return api.get('/protected/profile');
}
