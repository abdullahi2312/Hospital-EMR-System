'use strict';

function createLoginRateLimiter({
  windowMs = 15 * 60 * 1000,
  maxAttempts = 10,
  maxEntries = 10000,
  now = Date.now
} = {}) {
  const attemptsByAddress = new Map();

  return function loginRateLimit(req, res, next) {
    const address = req.socket?.remoteAddress || req.ip || 'unknown';
    const currentTime = now();
    let entry = attemptsByAddress.get(address);

    if (!entry || currentTime - entry.startedAt >= windowMs) {
      entry = { startedAt: currentTime, count: 0 };
    }

    if (entry.count >= maxAttempts) {
      const retryAfterSeconds = Math.max(1, Math.ceil((windowMs - (currentTime - entry.startedAt)) / 1000));
      res.set('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({
        success: false,
        message: 'Too many login attempts. Try again later.',
        data: null
      });
    }

    entry.count += 1;
    attemptsByAddress.delete(address);
    attemptsByAddress.set(address, entry);

    if (attemptsByAddress.size > maxEntries) {
      for (const [storedAddress, storedEntry] of attemptsByAddress) {
        if (currentTime - storedEntry.startedAt >= windowMs) attemptsByAddress.delete(storedAddress);
      }
      while (attemptsByAddress.size > maxEntries) {
        attemptsByAddress.delete(attemptsByAddress.keys().next().value);
      }
    }

    return next();
  };
}

const loginRateLimit = createLoginRateLimiter();

module.exports = { loginRateLimit, createLoginRateLimiter };
