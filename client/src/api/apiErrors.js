export function normalizeApiError(error) {
  const response = error?.response;
  const payload = response?.data;
  const issue = payload?.issue?.[0];

  return {
    status: response?.status ?? 0,
    message: payload?.message || issue?.diagnostics || error?.message || 'The request could not be completed.',
    data: payload?.data ?? null,
    partialSuccess: payload?.data?.partialSuccess === true,
    retrySameKey: payload?.data?.retrySameKey === true,
    retryAfter: response?.headers?.['retry-after'] ?? null,
    isNetworkError: !response
  };
}
