const USER_ROLES = require('../models/User').schema.path('role').enumValues;

function authorize(...allowedRoles) {
  if (allowedRoles.length === 0) {
    throw new TypeError('authorize requires at least one allowed role');
  }

  const invalidRoles = allowedRoles.filter(
    (role) => typeof role !== 'string' || !USER_ROLES.includes(role)
  );

  if (invalidRoles.length > 0) {
    throw new TypeError(
      `authorize received invalid role configuration: ${invalidRoles
        .map((role) => String(role))
        .join(', ')}`
    );
  }

  return function authorizeRequest(req, res, next) {
    if (!req.user || typeof req.user !== 'object') {
      return res.status(401).json({
        success: false,
        message: 'Authentication required',
        data: null
      });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to perform this action',
        data: null
      });
    }

    return next();
  };
}

module.exports = {
  authorize
};
