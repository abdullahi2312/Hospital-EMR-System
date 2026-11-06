'use strict';

const SUPPORTED_LANGUAGES = Object.freeze(['en', 'so']);

const SOMALI_SUCCESS = Object.freeze({
  'Login successful': 'Si guul leh ayaad u gashay.',
  'Patient registered successfully': 'Bukaanka si guul leh ayaa loo diiwaangeliyey.',
  'Hospital operational analytics retrieved successfully': 'Warbixinta hawlgalka isbitaalka si guul leh ayaa loo helay.',
  'Notifications retrieved successfully': 'Ogeysiisyada si guul leh ayaa loo helay.',
  'Notification marked as read': 'Ogeysiiska waxaa loo calaamadeeyey in la akhriyey.',
  'Simulated payment request processed. No real money was transferred.': 'Lacag-bixinta waa tijaabo la matalay; lacag dhab ah lama wareejin.'
});

const SOMALI_FAILURE_BY_STATUS = Object.freeze({
  400: 'Codsiga ama xogta la diray waa khaldan tahay.',
  401: 'Fadlan gal si aad u sii wadato.',
  403: 'Looma oggola inaad codsigan samayso.',
  404: 'Xogta la codsaday lama helin.',
  409: 'Codsigu wuxuu khilaafsan yahay xaaladda hadda jirta.',
  413: 'Codsiga aad buu u weyn yahay.',
  429: 'Codsiyo badan ayaa la diray. Mar kale isku day goor dambe.',
  500: 'Codsiga lama dhamaystiri karin hadda.',
  503: 'Adeegga si ku meel gaar ah looma heli karo.'
});

const SOMALI_NOTIFICATION_TEXT = Object.freeze({
  'Laboratory results ready': 'Natiijooyinka shaybaarku waa diyaar.',
  'All required laboratory results are ready for review in the EMR.': 'Dhammaan natiijooyinka shaybaarka waa diyaar si dib loogu eego nidaamka EMR.',
  'Referral update': 'Cusboonaysiinta gudbinta bukaanka',
  'A referral has been sent to you. Review it in the EMR.': 'Gudbin ayaa laguu soo diray. Ka eeg nidaamka EMR.',
  'A referral status was updated. Review the referral in the EMR.': 'Xaaladda gudbinta waa la cusboonaysiiyey. Ka eeg nidaamka EMR.',
  'Patient consent updated': 'Oggolaanshaha bukaanka waa la cusboonaysiiyey.',
  'A patient updated access permissions in the EMR.': 'Bukaan ayaa cusboonaysiiyey oggolaanshaha gelitaanka ee nidaamka EMR.',
  'A patient revoked access permissions. The change is effective immediately.': 'Bukaan ayaa ka noqday oggolaanshaha gelitaanka. Isbeddelku isla markiiba ayuu dhaqan galay.'
});

function chooseLanguage(headerValue) {
  if (typeof headerValue !== 'string') return 'en';
  const candidates = headerValue.split(',').map((entry, index) => {
    const [tag, ...parameters] = entry.trim().split(';');
    const quality = parameters.map((parameter) => /^q=(0(?:\.\d+)?|1(?:\.0+)?)$/i.exec(parameter.trim()))
      .find(Boolean);
    const q = quality ? Number(quality[1]) : 1;
    const language = tag.toLowerCase().split('-')[0];
    return { language, q, index };
  }).filter((entry) => SUPPORTED_LANGUAGES.includes(entry.language) && entry.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  return candidates[0]?.language || 'en';
}

function localizeApiEnvelope(body, statusCode, language) {
  if (language !== 'so' || !body || typeof body !== 'object' || typeof body.success !== 'boolean' || typeof body.message !== 'string') {
    return body;
  }
  if (body.success) {
    const translated = SOMALI_SUCCESS[body.message] || (/simulat/i.test(body.message)
      ? 'Hawlgalku waa tijaabo la matalay; lacag dhab ah lama wareejin.'
      : 'Hawlgalka si guul leh ayaa loo dhammeeyey.');
    return { ...body, message: translated };
  }
  return { ...body, message: SOMALI_FAILURE_BY_STATUS[statusCode] || 'Codsiga lama dhamaystiri karin.' };
}

function localizeNotification(notification, language) {
  if (language !== 'so' || !notification || typeof notification !== 'object') return notification;
  return {
    ...notification,
    ...(SOMALI_NOTIFICATION_TEXT[notification.title] ? { title: SOMALI_NOTIFICATION_TEXT[notification.title] } : {}),
    ...(SOMALI_NOTIFICATION_TEXT[notification.message] ? { message: SOMALI_NOTIFICATION_TEXT[notification.message] } : {})
  };
}

module.exports = { SUPPORTED_LANGUAGES, chooseLanguage, localizeApiEnvelope, localizeNotification };
