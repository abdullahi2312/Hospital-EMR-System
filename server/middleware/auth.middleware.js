const User = require('../models/User');
const { verifyToken } = require('../utils/token');

function unauthorized(res) {
  return res.status(401).json({
    success: false,
    message: 'Authentication required',
    data: null
  });
}

function getBearerToken(authorization) {
  if (typeof authorization !== 'string') {
    return null;
  }

  const match = authorization.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : null;
}

async function authenticate(req, res, next) {
  const token = getBearerToken(req.get('authorization'));
  if (!token) {
    return unauthorized(res);
  }

  let payload;
  try {
    payload = verifyToken(token);
  } catch (error) {
    if (error.name === 'TokenConfigurationError') {
      return next(error);
    }
    return unauthorized(res);
  }

  try {
    const user = await User.findById(payload.sub)
      .select('_id fullName username role patient isActive')
      .lean();

    if (!user || user.isActive !== true) {
      return unauthorized(res);
    }

    req.user = {
      id: user._id.toString(),
      fullName: user.fullName,
      username: user.username,
      role: user.role,
      ...(user.patient ? { patient: user.patient.toString() } : {})
    };

    return next();
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  authenticate
};
