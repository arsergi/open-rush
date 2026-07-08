const path = require('path');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);

const config = require('./config');
const { db, UPLOADS_DIR } = require('./db');
const { loadUser, csrfProtect, requireApproved, requireAdmin } = require('./middleware/guards');
const authRoutes = require('./routes/auth');
const pnmsRoutes = require('./routes/pnms');
const notesRoutes = require('./routes/notes');
const adminRoutes = require('./routes/admin');

const app = express();

if (config.TRUST_PROXY) app.set('trust proxy', 1);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
      },
    },
  })
);

app.use(express.urlencoded({ extended: false }));

app.use(
  session({
    store: new SqliteStore({
      client: db,
      expired: {
        clear: true,
        intervalMs: 15 * 60 * 1000,
      },
    }),
    name: 'open-rush.sid',
    secret: config.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.COOKIE_SECURE,
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    },
  })
);

app.use(express.static(path.join(__dirname, 'public')));

app.use(loadUser);
app.use(csrfProtect);

// PNM photos are private to approved members, not public assets -- mounted
// after session + loadUser (above) and gated by requireApproved so an
// unauthenticated request gets redirected to /login instead of the file.
app.use('/uploads', requireApproved, express.static(UPLOADS_DIR));

app.use('/', authRoutes);
app.use('/pnms', requireApproved, pnmsRoutes);
app.use('/notes', requireApproved, notesRoutes);
app.use('/admin', requireAdmin, adminRoutes);

app.get('/', (req, res) => {
  if (!req.user) {
    return res.redirect('/login');
  }
  if (req.user.status === 'pending' || req.user.status === 'rejected') {
    return res.redirect('/pending');
  }
  return res.redirect('/pnms');
});

// 404 handler
app.use((req, res) => {
  res.status(404).send('Not found');
});

// Error handler — never leak stack traces to the client. Fail closed: only
// show the real error message in development, everywhere else (including
// when NODE_ENV is unset) show a generic message.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  const isDev = process.env.NODE_ENV === 'development';
  res.status(err.status || 500).send(isDev ? `Server error: ${err.message}` : 'Something went wrong.');
});

if (require.main === module) {
  app.listen(config.PORT, () => {
    console.log(`open-rush listening on port ${config.PORT}`);
  });
}

module.exports = app;
