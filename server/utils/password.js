const bcrypt = require('bcrypt');

const BCRYPT_ROUNDS = 12;
const MAX_BCRYPT_PASSWORD_BYTES = 72;
const BCRYPT_HASH_PATTERN = /^\$2[aby]\$(\d{2})\$[./A-Za-z0-9]{53}$/;

function validatePassword(password) {
  if (typeof password !== 'string' || password.trim().length === 0) {
    throw new TypeError('Password must be a non-empty string');
  }

  if (Buffer.byteLength(password, 'utf8') > MAX_BCRYPT_PASSWORD_BYTES) {
    throw new RangeError(`Password cannot exceed ${MAX_BCRYPT_PASSWORD_BYTES} UTF-8 bytes when using bcrypt`);
  }
}

function isBcryptHash(value) {
  if (typeof value !== 'string') {
    return false;
  }

  const match = value.match(BCRYPT_HASH_PATTERN);
  return Boolean(match && Number(match[1]) >= 4 && Number(match[1]) <= 31);
}

async function hashPassword(password) {
  validatePassword(password);

  if (isBcryptHash(password)) {
    throw new TypeError('Password must be plaintext, not an existing bcrypt hash');
  }

  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

async function comparePassword(password, hashedPassword) {
  validatePassword(password);

  if (!isBcryptHash(hashedPassword)) {
    throw new TypeError('Hashed password must be a valid bcrypt hash string');
  }

  return bcrypt.compare(password, hashedPassword);
}

module.exports = {
  hashPassword,
  comparePassword
};
