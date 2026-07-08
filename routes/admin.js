const express = require('express');
const { db, getSetting, setSetting } = require('../db');
const { deletePhoto } = require('../lib/photos');
const { toCsv } = require('../lib/csv');

const router = express.Router();

// Mounted at /admin behind requireAdmin in app.js, so every handler below
// can assume req.user is a logged-in, approved admin.

const DECISIONS = new Set(['bid', 'no_bid', 'undecided']);
const RESET_CONFIRMATION = 'RESET RUSH';

function decisionLabel(decision) {
  return decision === 'no_bid' ? 'NO BID' : decision.toUpperCase();
}

function parseId(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    res.status(404).send('Not found');
    return null;
  }
  return id;
}

function currentSettings() {
  return {
    voteVisibility: getSetting('vote_visibility'),
    votingFrozen: getSetting('voting_frozen') === '1',
    signupsClosed: getSetting('signups_closed') === '1',
  };
}

function renderSettings(res, status, extra) {
  res.status(status).render(
    'admin/settings',
    Object.assign(
      { notice: null, settingsError: null, resetError: null },
      currentSettings(),
      extra
    )
  );
}

// ---------------------------------------------------------------------------
// GET /admin — dashboard
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  const pendingUsers = db
    .prepare("SELECT COUNT(*) AS n FROM users WHERE status = 'pending'")
    .get().n;
  const pendingPnms = db
    .prepare("SELECT COUNT(*) AS n FROM pnms WHERE status = 'pending'")
    .get().n;
  const activePnms = db
    .prepare("SELECT COUNT(*) AS n FROM pnms WHERE status = 'active'")
    .get().n;
  const approvedBrothers = db
    .prepare("SELECT COUNT(*) AS n FROM users WHERE status = 'approved' AND role = 'brother'")
    .get().n;

  res.render('admin/dashboard', {
    pendingUsers,
    pendingPnms,
    activePnms,
    approvedBrothers,
    notice: req.query.reset === '1' ? 'Rush data has been reset.' : null,
  });
});

// ---------------------------------------------------------------------------
// GET /admin/users — pending queue + full user table
// ---------------------------------------------------------------------------
router.get('/users', (req, res) => {
  const pending = db
    .prepare("SELECT * FROM users WHERE status = 'pending' ORDER BY created_at")
    .all();
  const all = db.prepare('SELECT * FROM users ORDER BY created_at').all();
  res.render('admin/users', { pending, all, currentUserId: req.user.id });
});

function loadTargetUser(req, res) {
  const id = parseId(req, res);
  if (id === null) return null;
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) {
    res.status(404).send('Not found');
    return null;
  }
  return target;
}

router.post('/users/:id/approve', (req, res) => {
  const target = loadTargetUser(req, res);
  if (!target) return;
  if (target.id === req.user.id || target.role === 'admin') {
    return res.status(400).send('Cannot approve/reject admins or yourself.');
  }
  db.prepare("UPDATE users SET status = 'approved' WHERE id = ?").run(target.id);
  res.redirect('/admin/users');
});

router.post('/users/:id/reject', (req, res) => {
  const target = loadTargetUser(req, res);
  if (!target) return;
  if (target.id === req.user.id || target.role === 'admin') {
    return res.status(400).send('Cannot approve/reject admins or yourself.');
  }
  db.prepare("UPDATE users SET status = 'rejected' WHERE id = ?").run(target.id);
  res.redirect('/admin/users');
});

// ---------------------------------------------------------------------------
// GET /admin/pnms — pending PNM queue
// ---------------------------------------------------------------------------
router.get('/pnms', (req, res) => {
  const pending = db
    .prepare(
      `SELECT p.*, u.username AS submitted_by_username
       FROM pnms p
       LEFT JOIN users u ON u.id = p.submitted_by
       WHERE p.status = 'pending'
       ORDER BY p.created_at`
    )
    .all();
  res.render('admin/pnms', { pending, decisionLabel });
});

router.post('/pnms/:id/approve', (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;
  const info = db.prepare("UPDATE pnms SET status = 'active' WHERE id = ?").run(id);
  if (info.changes === 0) return res.status(404).send('Not found');
  res.redirect('/admin/pnms');
});

router.post('/pnms/:id/reject', (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;
  const info = db.prepare("UPDATE pnms SET status = 'rejected' WHERE id = ?").run(id);
  if (info.changes === 0) return res.status(404).send('Not found');
  res.redirect('/admin/pnms');
});

// ---------------------------------------------------------------------------
// POST /admin/pnms/:id/decision — badge only, voting stays open regardless.
// ---------------------------------------------------------------------------
router.post('/pnms/:id/decision', (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;

  const decision = req.body && req.body.decision;
  if (!DECISIONS.has(decision)) {
    return res.status(400).send('Invalid decision.');
  }

  const info = db.prepare('UPDATE pnms SET decision = ? WHERE id = ?').run(decision, id);
  if (info.changes === 0) return res.status(404).send('Not found');

  res.redirect(`/pnms/${id}`);
});

// ---------------------------------------------------------------------------
// POST /admin/pnms/:id/delete — cascades votes/notes/reactions via FK,
// then removes the photo file from disk (if any).
// ---------------------------------------------------------------------------
router.post('/pnms/:id/delete', (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;

  const pnm = db.prepare('SELECT photo FROM pnms WHERE id = ?').get(id);
  if (!pnm) return res.status(404).send('Not found');

  db.prepare('DELETE FROM pnms WHERE id = ?').run(id);
  if (pnm.photo) deletePhoto(pnm.photo);

  res.redirect('/pnms');
});

// ---------------------------------------------------------------------------
// GET/POST /admin/settings
// ---------------------------------------------------------------------------
router.get('/settings', (req, res) => {
  renderSettings(res, 200, {
    notice: req.query.saved === '1' ? 'Settings saved.' : null,
  });
});

router.post('/settings', (req, res) => {
  const body = req.body || {};
  const voteVisibility = body.vote_visibility;
  if (voteVisibility !== 'anonymous' && voteVisibility !== 'public') {
    return renderSettings(res, 400, { settingsError: 'Invalid vote visibility option.' });
  }

  setSetting('vote_visibility', voteVisibility);
  setSetting('voting_frozen', body.voting_frozen === '1' ? '1' : '0');
  setSetting('signups_closed', body.signups_closed === '1' ? '1' : '0');

  res.redirect('/admin/settings?saved=1');
});

// ---------------------------------------------------------------------------
// POST /admin/reset — danger zone: requires typed "RESET RUSH" confirmation.
// Deletes all pnms (cascades votes/notes/reactions) and their photo files.
// User accounts are untouched.
// ---------------------------------------------------------------------------
router.post('/reset', (req, res) => {
  const confirmText = String((req.body && req.body.confirm) || '').trim();
  if (confirmText !== RESET_CONFIRMATION) {
    return renderSettings(res, 400, {
      resetError: `Type ${RESET_CONFIRMATION} exactly to confirm.`,
    });
  }

  const photos = db.prepare('SELECT photo FROM pnms WHERE photo IS NOT NULL').all();
  db.prepare('DELETE FROM pnms').run();
  for (const row of photos) {
    deletePhoto(row.photo);
  }

  res.redirect('/admin?reset=1');
});

// ---------------------------------------------------------------------------
// GET /admin/export.csv
// ---------------------------------------------------------------------------
router.get('/export.csv', (req, res) => {
  const rows = db
    .prepare(
      `SELECT
         p.name,
         p.phone,
         p.instagram,
         p.hometown,
         COALESCE(y.cnt, 0) AS yes_votes,
         COALESCE(n.cnt, 0) AS no_votes,
         p.decision,
         COALESCE(nt.cnt, 0) AS notes_count
       FROM pnms p
       LEFT JOIN (SELECT pnm_id, COUNT(*) AS cnt FROM votes WHERE value = 1 GROUP BY pnm_id) y
         ON y.pnm_id = p.id
       LEFT JOIN (SELECT pnm_id, COUNT(*) AS cnt FROM votes WHERE value = 0 GROUP BY pnm_id) n
         ON n.pnm_id = p.id
       LEFT JOIN (SELECT pnm_id, COUNT(*) AS cnt FROM notes GROUP BY pnm_id) nt
         ON nt.pnm_id = p.id
       WHERE p.status = 'active'
       ORDER BY p.name COLLATE NOCASE`
    )
    .all();

  const header = [
    'name',
    'phone',
    'instagram',
    'hometown',
    'yes_votes',
    'no_votes',
    'decision',
    'notes_count',
  ];
  const body = rows.map((r) => [
    r.name,
    r.phone,
    r.instagram,
    r.hometown,
    r.yes_votes,
    r.no_votes,
    r.decision,
    r.notes_count,
  ]);
  const csv = toCsv([header, ...body]);

  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="pnms.csv"');
  res.send(csv);
});

module.exports = router;
