'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const dotenv = require('dotenv');

const projectRoot = path.resolve(__dirname, '../..');
const baseEnvPath = path.join(projectRoot, '.env');
const localEnvPath = path.join(projectRoot, '.env.local');
const secretName = 'PATIENT_IDENTITY_HMAC_SECRET';
const minBytes = 32;

function getSecretFromFile(filePath) {
  if (!fs.existsSync(filePath)) return undefined;
  const parsed = dotenv.parse(fs.readFileSync(filePath));
  return parsed[secretName];
}

function isValid(secret) {
  return typeof secret === 'string' && Buffer.byteLength(secret, 'utf8') >= minBytes;
}

function ensureLocalPatientSecret() {
  const baseSecret = getSecretFromFile(baseEnvPath);
  const localSecret = getSecretFromFile(localEnvPath);

  if (baseSecret !== undefined) {
    if (!isValid(baseSecret)) {
      throw new Error(`${secretName} is already set in .env but is shorter than ${minBytes} bytes. Preserve and repair the existing key; it is used to match existing patient identity fingerprints.`);
    }
    return 'existing';
  }

  if (localSecret !== undefined) {
    if (!isValid(localSecret)) {
      throw new Error(`${secretName} in .env.local is shorter than ${minBytes} bytes. Repair the existing key without rotating it.`);
    }
    return 'existing';
  }

  const secret = randomBytes(32).toString('hex');
  const separator = fs.existsSync(localEnvPath) && fs.statSync(localEnvPath).size > 0 ? '\n' : '';
  fs.appendFileSync(localEnvPath, `${separator}${secretName}=${secret}\n`, { flag: 'a', mode: 0o600 });
  return 'created';
}

if (require.main === module) {
  try {
    const result = ensureLocalPatientSecret();
    console.log(result === 'created'
      ? 'A local patient identity key was created in the Git-ignored .env.local file.'
      : 'A valid patient identity key is already configured; it was preserved.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { ensureLocalPatientSecret };
