const User = require('../models/User');
const { comparePassword } = require('../utils/password');
const Patient = require('../models/Patient');
const { generateToken } = require('../utils/token');

const AUTH_ERROR_MESSAGE = 'Invalid username or password';

function createAuthError(message, status) {
  const error = new Error(message);
  error.name = 'AuthenticationServiceError';
  error.status = status;
  return error;
}

function invalidCredentials() {
  return createAuthError(AUTH_ERROR_MESSAGE, 401);
}

function validateCredentials(username, password) {
  if (
    typeof username !== 'string' ||
    username.trim().length < 3 ||
    username.trim().length > 30 ||
    typeof password !== 'string' ||
    password.trim().length === 0
  ) {
    throw createAuthError('A valid username and password are required', 400);
  }
}

function toSafeUser(user) {
  const safeUser = {
    id: user._id.toString(),
    fullName: user.fullName,
    username: user.username,
    role: user.role
  };

  if (user.patient) {
    safeUser.patient = user.patient.toString();
  }

  return safeUser;
}

async function loginUser(username, password) {
  validateCredentials(username, password);
  const normalizedUsername = username.trim().toLowerCase();

  let user;
  try {
    user = await User.findOne({ username: normalizedUsername }).select('+password');
  } catch (_) {
    throw createAuthError('Unable to authenticate user', 500);
  }

  if (!user) {
    throw invalidCredentials();
  }

  let passwordMatches;
  try {
    passwordMatches = await comparePassword(password, user.password);
  } catch (error) {
    if (error instanceof RangeError) {
      throw createAuthError('A valid username and password are required', 400);
    }
    if (error instanceof TypeError) {
      passwordMatches = false;
    } else {
      throw createAuthError('Unable to authenticate user', 500);
    }
  }

  if (!passwordMatches || user.isActive !== true) {
    throw invalidCredentials();
  }

  let token;
  try {
    token = generateToken(user);
  } catch (error) {
    if (error.name === 'TokenConfigurationError') {
      throw createAuthError('Authentication is not configured', 500);
    }
    throw createAuthError('Unable to authenticate user', 500);
  }

  return {
    token,
    user: toSafeUser(user)
  };
}

function normalizePatientPhone(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\D/g, '').replace(/^00/, '');
}

async function loginPatientUser(mrn, phone, password) {
  const normalizedMrn = typeof mrn === 'string' ? mrn.trim().toUpperCase() : '';
  const normalizedPhone = normalizePatientPhone(phone);
  if (!/^MRN-\d{6}$/.test(normalizedMrn) || normalizedPhone.length < 6 || normalizedPhone.length > 30 ||
      typeof password !== 'string' || password.trim().length === 0) {
    throw createAuthError('A valid MRN, phone number, and password are required', 400);
  }

  let patient;
  try {
    patient = await Patient.findOne({ mrn: normalizedMrn }).select('_id phone').lean();
  } catch (_) {
    throw createAuthError('Unable to authenticate patient', 500);
  }
  if (!patient || normalizePatientPhone(patient.phone) !== normalizedPhone) throw invalidCredentials();

  let user;
  try {
    user = await User.findOne({ role: 'patient', patient: patient._id }).select('+password');
  } catch (_) {
    throw createAuthError('Unable to authenticate patient', 500);
  }
  if (!user) throw invalidCredentials();

  let passwordMatches;
  try {
    passwordMatches = await comparePassword(password, user.password);
  } catch (error) {
    if (error instanceof RangeError) throw createAuthError('A valid MRN, phone number, and password are required', 400);
    if (error instanceof TypeError) passwordMatches = false;
    else throw createAuthError('Unable to authenticate patient', 500);
  }
  if (!passwordMatches || user.isActive !== true || String(user.patient) !== String(patient._id)) throw invalidCredentials();

  let token;
  try {
    token = generateToken(user);
  } catch (error) {
    if (error.name === 'TokenConfigurationError') throw createAuthError('Authentication is not configured', 500);
    throw createAuthError('Unable to authenticate patient', 500);
  }
  return { token, user: toSafeUser(user) };
}

module.exports = { loginUser, loginPatientUser };
