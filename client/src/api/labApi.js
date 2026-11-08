import { api } from './httpClient.js';

export const labApi = {
  pendingOrders: (params = {}) => api.get('/lab/orders/pending', { params }),
  order: (orderId) => api.get(`/lab/orders/${encodeURIComponent(orderId)}`),
  recordResult: (orderId, payload) => api.post(`/lab/orders/${encodeURIComponent(orderId)}/results`, payload),
  rejectSample: (orderId, payload) => api.patch(`/lab/orders/${encodeURIComponent(orderId)}/reject-sample`, payload)
};
