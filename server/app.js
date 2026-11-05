const express = require('express');
const healthRoutes = require('./routes/health.routes');
const authRoutes = require('./routes/auth.routes');
const protectedRoutes = require('./routes/protected.routes');
const adminRoutes = require('./routes/admin.routes');
const patientRoutes = require('./routes/patient.routes');
const patientTimelineRoutes = require('./routes/patient-timeline.routes');
const encounterRoutes = require('./routes/encounter.routes');
const labRoutes = require('./routes/lab.routes');
const pharmacyRoutes = require('./routes/pharmacy.routes');
const consentRoutes = require('./routes/consent.routes');
const referralRoutes = require('./routes/referral.routes');
const paymentRoutes = require('./routes/payment.routes');
const fhirRoutes = require('./routes/fhir.routes');
const notFound = require('./middleware/not-found');
const errorHandler = require('./middleware/error-handler');

const app = express();

app.use(express.json());
app.use('/api', healthRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/protected', protectedRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/patients', patientRoutes);
app.use('/api/patients', patientTimelineRoutes);
app.use('/api/encounters', encounterRoutes);
app.use('/api/encounters', labRoutes.encounterRouter);
app.use('/api/lab', labRoutes);
app.use('/api/pharmacy', pharmacyRoutes);
app.use('/api/consents', consentRoutes);
app.use('/api/referrals', referralRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/fhir', fhirRoutes);
app.use(notFound);
app.use(errorHandler);

module.exports = app;
