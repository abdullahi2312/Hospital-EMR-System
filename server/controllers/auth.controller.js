const { loginUser } = require('../services/auth.service');

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

module.exports = { login };
