'use strict';

const mongoose = require('mongoose');

// Keep this list explicit so startup index readiness covers models that are
// only referenced by services and are not necessarily loaded by a route.
const MODEL_FILES = [
  'AccessLog', 'Allergy', 'AuditLog', 'BreakGlass', 'Consent', 'Department',
  'Diagnosis', 'Dispense', 'Encounter', 'Inventory', 'InventoryStockAddition',
  'LabOrder', 'LabResult', 'Medication', 'Notification', 'Patient',
  'PatientRegistrationOperation', 'Payment', 'Prescription', 'Referral',
  'User', 'Vital'
];

function loadModels() {
  for (const modelName of MODEL_FILES) {
    require(`../models/${modelName}`);
  }
  return MODEL_FILES.map((modelName) => mongoose.model(modelName));
}

/**
 * Build/verify declared indexes without dropping or synchronizing existing
 * indexes. Unique-index build failures (for example, historical duplicates)
 * are surfaced and must be resolved through an explicit migration.
 */
async function ensureIndexes(models = loadModels()) {
  for (const model of models) {
    try {
      await model.createIndexes();
    } catch (_) {
      const error = new Error(`MongoDB index initialization failed for model ${model.modelName}`);
      error.name = 'IndexReadinessError';
      error.modelName = model.modelName;
      throw error;
    }
  }
  return { modelCount: models.length };
}

module.exports = { ensureIndexes, MODEL_FILES };
