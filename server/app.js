const express = require('express');
const healthRoutes = require('./routes/health.routes');
const notFound = require('./middleware/not-found');
const errorHandler = require('./middleware/error-handler');

const app = express();

app.use(express.json());
app.use('/api', healthRoutes);
app.use(notFound);
app.use(errorHandler);

module.exports = app;
