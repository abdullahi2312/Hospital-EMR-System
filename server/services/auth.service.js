const User = require('../models/User');
const { comparePassword } = require('../utils/password');
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

  if (!passwordMatches || user.isActive === false) {
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

module.exports = {
  loginUser
};
