const mongoose = require('mongoose');
const User = require('../models/User');
const { hashPassword, comparePassword } = require('../utils/password');

function createServiceError(message, statusCode) {
  const error = new Error(message);
  error.name = 'UserServiceError';
  error.status = statusCode;
  error.statusCode = statusCode;
  return error;
}

function toSafeUser(user) {
  const safeUser = user.toObject();
  delete safeUser.password;
  return safeUser;
}

function sanitizePersistenceError(error) {
  if (error.name === 'ValidationError') {
    const fields = Object.keys(error.errors || {}).filter((field) => field !== 'password');
    const detail = fields.length ? `: ${fields.join(', ')}` : '';
    return createServiceError(`User validation failed${detail}`, 400);
  }

  if (error.code === 11000) {
    const fields = Object.keys(error.keyPattern || {}).filter((field) => field !== 'password');
    const detail = fields.length ? fields.join(', ') : 'User data';
    return createServiceError(`${detail} already exists`, 409);
  }

  return createServiceError('Unable to save user', 500);
}

function validateUserInput(userData) {
  if (!userData || typeof userData !== 'object' || Array.isArray(userData)) {
    throw createServiceError('User data must be an object', 400);
  }
}

async function createUser(userData) {
  validateUserInput(userData);
  const { password, ...userFields } = userData;
  const hashedPassword = await hashPassword(password);
  const user = new User({ ...userFields, password: hashedPassword });

  try {
    await user.validate();
    const savedUser = await user.save();
    return toSafeUser(savedUser);
  } catch (error) {
    throw sanitizePersistenceError(error);
  }
}

async function updateUserPassword(userId, newPassword) {
  if (!mongoose.isValidObjectId(userId)) {
    throw createServiceError('A valid user ID is required', 400);
  }

  let user;
  try {
    user = await User.findById(userId);
  } catch (_) {
    throw createServiceError('Unable to update user password', 500);
  }

  if (!user) {
    throw createServiceError('User not found', 404);
  }

  user.password = await hashPassword(newPassword);

  try {
    await user.save();
    return toSafeUser(user);
  } catch (error) {
    throw sanitizePersistenceError(error);
  }
}

async function verifyUserPassword(userId, password) {
  if (!mongoose.isValidObjectId(userId)) {
    return false;
  }

  let user;
  try {
    user = await User.findById(userId).select('+password');
  } catch (_) {
    throw createServiceError('Unable to verify user password', 500);
  }

  if (!user) {
    return false;
  }

  try {
    return await comparePassword(password, user.password);
  } catch (error) {
    if (error.message === 'Hashed password must be a valid bcrypt hash string') {
      return false;
    }
    if (error instanceof TypeError || error instanceof RangeError) {
      throw createServiceError(error.message, 400);
    }
    throw createServiceError('Unable to verify user password', 500);
  }
}

module.exports = {
  createUser,
  updateUserPassword,
  verifyUserPassword
};
