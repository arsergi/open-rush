require('dotenv').config();

const PORT = parseInt(process.env.PORT, 10) || 3000;
const DATA_DIR = process.env.DATA_DIR || './data';
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  throw new Error(
    'SESSION_SECRET is required. Set it in your .env file (see .env.example) ' +
      'or as an environment variable before starting the app.'
  );
}

module.exports = {
  PORT,
  DATA_DIR,
  SESSION_SECRET,
  COOKIE_SECURE,
  TRUST_PROXY,
};
