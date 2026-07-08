const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const { db, getSetting } = require('../db');
const validate = require('../lib/validate');

const router = express.Router();

const BCRYPT_COST = 12;

// Precomputed hash of a random value so a login attempt for a nonexistent
// user still pays the bcrypt.compare cost — avoids leaking user existence
// via response timing.
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), BCRYPT_COST);

const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many attempts. Please try again later.',
});

const getUserByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
const getUserByUsername = db.prepare('SELECT * FROM users WHERE username = ?');
const insertUser = db.prepare(
  `INSERT INTO users (email, username, password_hash, role, status)
   VALUES (?, ?, ?, 'brother', 'pending')`
);

router.get('/signup', (req, res) => {
  const signupsClosed = getSetting('signups_closed') === '1';
  res.render('auth/signup', {
    signupsClosed,
    error: null,
    values: { email: '', username: '' },
  });
});

router.post('/signup', authRateLimit, (req, res) => {
  const signupsClosed = getSetting('signups_closed') === '1';
  if (signupsClosed) {
    return res.status(403).render('auth/signup', {
      signupsClosed: true,
      error: 'Signups are currently closed.',
      values: { email: '', username: '' },
    });
  }

  const body = req.body || {};
  const values = { email: body.email || '', username: body.username || '' };

  const emailResult = validate.email(body.email);
  if (!emailResult.ok) {
    return res
      .status(400)
      .render('auth/signup', { signupsClosed, error: emailResult.error, values });
  }

  const usernameResult = validate.username(body.username);
  if (!usernameResult.ok) {
    return res
      .status(400)
      .render('auth/signup', { signupsClosed, error: usernameResult.error, values });
  }

  const passwordResult = validate.password(body.password);
  if (!passwordResult.ok) {
    return res
      .status(400)
      .render('auth/signup', { signupsClosed, error: passwordResult.error, values });
  }

  if (getUserByEmail.get(emailResult.value) || getUserByUsername.get(usernameResult.value)) {
    return res.status(400).render('auth/signup', {
      signupsClosed,
      error: 'That email or username is already in use.',
      values,
    });
  }

  const passwordHash = bcrypt.hashSync(passwordResult.value, BCRYPT_COST);

  try {
    insertUser.run(emailResult.value, usernameResult.value, passwordHash);
  } catch (err) {
    // Race-condition fallback in case of a concurrent duplicate insert.
    return res.status(400).render('auth/signup', {
      signupsClosed,
      error: 'That email or username is already registered.',
      values,
    });
  }

  res.render('auth/login', {
    error: null,
    notice: 'Account created. An admin needs to approve you before you can sign in.',
    values: { username: usernameResult.value },
  });
});

router.get('/login', (req, res) => {
  res.render('auth/login', { error: null, notice: null, values: { username: '' } });
});

router.post('/login', authRateLimit, (req, res) => {
  const body = req.body || {};
  const usernameOrEmail = String(body.username || '').trim();
  const values = { username: usernameOrEmail };

  const user =
    getUserByUsername.get(usernameOrEmail) || getUserByEmail.get(usernameOrEmail);

  const hashToCheck = user ? user.password_hash : DUMMY_HASH;
  const passwordOk = bcrypt.compareSync(String(body.password || ''), hashToCheck);

  if (!user || !passwordOk) {
    return res
      .status(401)
      .render('auth/login', { error: 'Invalid credentials.', notice: null, values });
  }

  req.session.regenerate((err) => {
    if (err) {
      return res
        .status(500)
        .render('auth/login', { error: 'Something went wrong. Please try again.', notice: null, values });
    }
    req.session.userId = user.id;
    req.session.save(() => {
      res.redirect('/');
    });
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

router.get('/pending', (req, res) => {
  if (!req.user) {
    return res.redirect('/login');
  }
  res.render('auth/pending', { status: req.user.status });
});

module.exports = router;
