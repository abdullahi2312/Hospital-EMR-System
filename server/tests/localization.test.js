'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseLanguage, localizeApiEnvelope, localizeNotification } = require('../utils/i18n');

test('language negotiation allows Somali and English and defaults safely to English', () => {
  assert.equal(chooseLanguage('so-SO, en;q=0.8'), 'so');
  assert.equal(chooseLanguage('fr, en-US;q=0.7'), 'en');
  assert.equal(chooseLanguage('fr'), 'en');
  assert.equal(chooseLanguage(undefined), 'en');
  assert.equal(chooseLanguage('so;q=0, en;q=0.5'), 'en');
});

test('Somali localizes stable response envelope messages without changing data or identifiers', () => {
  const original = {
    success: true,
    message: 'Hospital operational analytics retrieved successfully',
    data: { status: 'simulated_success', id: 'abc123', count: 7 }
  };
  const translated = localizeApiEnvelope(original, 200, 'so');
  assert.equal(translated.message, 'Warbixinta hawlgalka isbitaalka si guul leh ayaa loo helay.');
  assert.deepEqual(translated.data, original.data);
  assert.equal(localizeApiEnvelope(original, 200, 'en'), original);
});

test('Somali validation and authorization errors are localized by status with stable response shape', () => {
  const error = localizeApiEnvelope({ success: false, message: 'raw internal validation detail', data: null }, 400, 'so');
  assert.deepEqual(error, { success: false, message: 'Codsiga ama xogta la diray waa khaldan tahay.', data: null });
  const forbidden = localizeApiEnvelope({ success: false, message: 'English detail', data: null }, 403, 'so');
  assert.equal(forbidden.message, 'Looma oggola inaad codsigan samayso.');
});

test('supported notification templates are localized without translating references or clinical payloads', () => {
  const notification = { id: 'abc123', title: 'Laboratory results ready', message: 'All required laboratory results are ready for review in the EMR.', relatedId: 'def456' };
  const translated = localizeNotification(notification, 'so');
  assert.equal(translated.title, 'Natiijooyinka shaybaarku waa diyaar.');
  assert.equal(translated.relatedId, 'def456');
  assert.equal(localizeNotification(notification, 'en'), notification);
  assert.equal(localizeNotification({ ...notification, message: 'private arbitrary text' }, 'so').message, 'private arbitrary text');
});

