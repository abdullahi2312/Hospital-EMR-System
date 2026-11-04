const jwt = require('jsonwebtoken');

const USER_ID_PATTERN = /^[a-f\d]{24}$/i;
const EXPIRY_PATTERN = /^[1-9]\d*(s|m|h|d|w)$/;
const PLACEHOLDER_PATTERN = /replace|placeholder|example|your[_ -]?secret|change[_ -]?me/i;

function createTokenError(message, name = 'TokenError') {
  const error = new Error(message);
  error.name = name;
  return error;
}

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (typeof secret !== 'string' || secret.length === 0) {
    throw createTokenError('JWT_SECRET is required', 'TokenConfigurationError');
  }

  const uniqueCharacters = new Set(secret).size;
  if (
    Buffer.byteLength(secret, 'utf8') < 32 ||
    uniqueCharacters < 16 ||
    PLACEHOLDER_PATTERN.test(secret)
  ) {
    throw createTokenError(
      'JWT_SECRET must be a strong random value of at least 32 bytes',
      'TokenConfigurationError'
    );
  }

  return secret;
}

function getExpiresIn() {
  const expiresIn = process.env.JWT_EXPIRES_IN;
  if (typeof expiresIn !== 'string' || !EXPIRY_PATTERN.test(expiresIn)) {
    throw createTokenError(
      'JWT_EXPIRES_IN must be a positive duration such as 1d',
      'TokenConfigurationError'
    );
  }

  return expiresIn;
}

function getUserId(user) {
  if (!user || typeof user !== 'object') {
    throw createTokenError('A valid user is required', 'TokenInputError');
  }

  const id = user._id ?? user.id;
  const userId = id == null ? '' : String(id);
  if (!USER_ID_PATTERN.test(userId)) {
    throw createTokenError('A valid user ID is required', 'TokenInputError');
  }

  if (typeof user.role !== 'string' || user.role.trim().length === 0) {
    throw createTokenError('A valid user role is required', 'TokenInputError');
  }

  return { userId, role: user.role };
}

function generateToken(user) {
  const secret = getJwtSecret();
  const expiresIn = getExpiresIn();
  const { userId, role } = getUserId(user);

  return jwt.sign(
    { sub: userId, role },
    secret,
    { algorithm: 'HS256', expiresIn }
  );
}

function verifyToken(token) {
  const secret = getJwtSecret();
  if (typeof token !== 'string' || token.trim().length === 0 || token.length > 8192) {
    throw createTokenError('Invalid or expired token');
  }

  let payload;
  try {
    payload = jwt.verify(token, secret, { algorithms: ['HS256'] });
  } catch (_) {
    throw createTokenError('Invalid or expired token');
  }

  if (
    !payload ||
    typeof payload !== 'object' ||
    typeof payload.sub !== 'string' ||
    !USER_ID_PATTERN.test(payload.sub) ||
    typeof payload.role !== 'string' ||
    payload.role.trim().length === 0
  ) {
    throw createTokenError('Invalid or expired token');
  }

  return payload;
}

module.exports = {
  generateToken,
  verifyToken
};
