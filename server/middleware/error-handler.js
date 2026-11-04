function errorHandler(error, _req, res, _next) {
  const status = Number(error.status) || 500;
  const message = status === 500 ? 'Internal server error' : error.message;

  if (status >= 500) {
    console.error(error);
  }

  res.status(status).json({
    success: false,
    message,
    data: null
  });
}

module.exports = errorHandler;
