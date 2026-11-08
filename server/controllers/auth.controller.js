const { loginUser } = require('../services/auth.service');

const { loginPatientUser } = require('../services/auth.service');

async function login(req, res, next) {
  try {
    const { username, password } = req.body || {};
    const result = await loginUser(username, password);

    return res.status(200).json({
      success: true,
      message: 'Login successful',
      data: {
        token: result.token,
        user: result.user
      }
    });
  } catch (error) {
    return next(error);
  }
}

async function patientLogin(req, res, next) {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some((key) => !['mrn', 'phone', 'password'].includes(key))) {
    return res.status(400).json({ success: false, message: 'Request contains unsupported fields', data: null });
  }
  try {
    const result = await loginPatientUser(body.mrn, body.phone, body.password);
    return res.status(200).json({ success: true, message: 'Login successful', data: { token: result.token, user: result.user } });
  } catch (error) {
    return next(error);
  }
}

module.exports = { login, patientLogin };
