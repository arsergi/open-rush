const crypto = require('crypto');
const { db } = require('../db');

const getUserStmt = db.prepare('SELECT * FROM users WHERE id = ?');

// Attaches the fresh DB row for the logged-in user (if any) to req.user and
// res.locals.currentUser. Runs on every request.
function loadUser(req, res, next) {
  req.user = null;
  res.locals.currentUser = null;

  if (req.session && req.session.userId) {
    const user = getUserStmt.get(req.session.userId);
    if (user) {
      req.user = user;
      res.locals.currentUser = user;
    }
  }

  next();
}

function requireAuth(req, res, next) {
  if (!req.user) {
    return res.redirect('/login');
  }
  next();
}

function requireApproved(req, res, next) {
  if (!req.user) {
    return res.redirect('/login');
  }
  if (req.user.status === 'pending' || req.user.status === 'rejected') {
    return res.redirect('/pending');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.redirect('/login');
  }
  if (req.user.status === 'pending' || req.user.status === 'rejected') {
    return res.redirect('/pending');
  }
  if (req.user.role !== 'admin') {
    return res.status(403).send('Forbidden');
  }
  next();
}

const CSRF_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Timing-safe comparison of the submitted token against the session's token.
// Shared by the global check and the post-multer re-check below.
function tokenMatches(req) {
  const provided = req.body && req.body._csrf;
  const expected = req.session && req.session.csrfToken;

  if (typeof provided !== 'string' || typeof expected !== 'string') {
    return false;
  }

  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);

  return (
    providedBuf.length === expectedBuf.length &&
    crypto.timingSafeEqual(providedBuf, expectedBuf)
  );
}

// Standard per-session synchronizer token pattern. Lazily creates a token on
// the session, exposes it to every view via res.locals.csrfToken, and rejects
// any state-changing request that doesn't echo it back correctly.
//
// Multipart exception: this middleware runs globally, before any route-level
// multer parsing. express.urlencoded() (mounted earlier in app.js) only
// parses application/x-www-form-urlencoded bodies, so for a
// multipart/form-data request req.body is still empty here -- req.body._csrf
// genuinely doesn't exist yet, not because the token is missing. Rejecting
// here would 403 every legitimate multipart POST, not just forged ones. So
// for multipart requests we skip the check in this pass and rely on the
// route re-running csrfCheck (below) itself, after its own multer middleware
// has parsed the body. Every multipart POST route MUST do this -- see
// routes/pnms.js.
function csrfProtect(req, res, next) {
  if (!req.session) {
    return next(new Error('csrfProtect requires session middleware'));
  }

  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;

  if (!CSRF_METHODS.has(req.method)) {
    return next();
  }

  const contentType = req.headers['content-type'] || '';
  if (contentType.startsWith('multipart/form-data')) {
    return next();
  }

  if (!tokenMatches(req)) {
    return res.status(403).send('Invalid CSRF token');
  }

  next();
}

// Explicit CSRF check for multipart routes. Must be mounted AFTER the
// route's own multer middleware (which is what actually populates
// req.body._csrf for a multipart request) -- see routes/pnms.js for the
// upload -> csrfCheck -> handler ordering.
function csrfCheck(req, res, next) {
  if (!tokenMatches(req)) {
    return res.status(403).send('Invalid CSRF token');
  }
  next();
}

module.exports = {
  loadUser,
  requireAuth,
  requireApproved,
  requireAdmin,
  csrfProtect,
  csrfCheck,
};
