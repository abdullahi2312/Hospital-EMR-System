'use strict';

const { chooseLanguage, localizeApiEnvelope } = require('../utils/i18n');

function localization(req, res, next) {
  const language = chooseLanguage(req.get('Accept-Language'));
  req.language = language;
  res.locals.language = language;
  const sendJson = res.json.bind(res);
  res.json = (body) => sendJson(localizeApiEnvelope(body, res.statusCode, language));
  next();
}

module.exports = localization;
