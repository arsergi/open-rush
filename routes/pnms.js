const express = require('express');
const { db, getSetting } = require('../db');
const validate = require('../lib/validate');
const { uploadPhoto, processUpload, deletePhoto } = require('../lib/photos');
const { csrfCheck } = require('../middleware/guards');
const { attachReactions } = require('../lib/reactions');

const router = express.Router();

// This whole router is mounted behind requireApproved in app.js, so every
// handler below can assume req.user is a logged-in, approved user.

// Wraps an async route handler so a rejected promise (e.g. from
// processUpload) reaches Express's error handler instead of crashing the
// process with an unhandled rejection.
function asyncRoute(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

const DECISIONS = new Set(['bid', 'no_bid', 'undecided']);
const VOTED_FILTERS = new Set(['yes', 'no', 'none']);

function decisionLabel(decision) {
  return decision === 'no_bid' ? 'NO BID' : decision.toUpperCase();
}

// ---------------------------------------------------------------------------
// GET /pnms — list + search + filters
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  const q = String(req.query.q || '').trim();
  const decisionFilter = DECISIONS.has(req.query.decision) ? req.query.decision : '';
  const votedFilter = VOTED_FILTERS.has(req.query.voted) ? req.query.voted : '';
  const isAdmin = req.user.role === 'admin';

  // Active PNMs are visible to everyone; pending (or rejected) ones only to
  // the admin and to the brother who submitted them.
  const params = [req.user.id]; // uv.user_id = ? (vote join)
  const conditions = ["(p.status = 'active' OR (p.status != 'active' AND (? = 1 OR p.submitted_by = ?)))"];
  params.push(isAdmin ? 1 : 0, req.user.id);

  if (q) {
    const escaped = validate.escapeLike(q);
    conditions.push("(p.name LIKE ? ESCAPE '\\' OR p.hometown LIKE ? ESCAPE '\\')");
    const pattern = `%${escaped}%`;
    params.push(pattern, pattern);
  }

  if (decisionFilter) {
    conditions.push('p.decision = ?');
    params.push(decisionFilter);
  }

  if (votedFilter === 'yes') {
    conditions.push('uv.value = 1');
  } else if (votedFilter === 'no') {
    conditions.push('uv.value = 0');
  } else if (votedFilter === 'none') {
    conditions.push('uv.value IS NULL');
  }

  const sql = `
    SELECT p.*,
      (SELECT COUNT(*) FROM votes v WHERE v.pnm_id = p.id AND v.value = 1) AS yes_count,
      (SELECT COUNT(*) FROM votes v WHERE v.pnm_id = p.id AND v.value = 0) AS no_count,
      uv.value AS my_vote
    FROM pnms p
    LEFT JOIN votes uv ON uv.pnm_id = p.id AND uv.user_id = ?
    WHERE ${conditions.join(' AND ')}
    ORDER BY p.name COLLATE NOCASE
  `;

  const pnms = db.prepare(sql).all(...params);

  res.render('pnms/index', {
    pnms,
    q,
    decisionFilter,
    votedFilter,
    decisionLabel,
    notice: req.query.submitted === '1' ? 'Submitted for approval.' : null,
  });
});

// ---------------------------------------------------------------------------
// GET /pnms/new — must be registered before GET /pnms/:id
// ---------------------------------------------------------------------------
router.get('/new', (req, res) => {
  res.render('pnms/form', {
    mode: 'new',
    isAdmin: req.user.role === 'admin',
    pnm: null,
    values: { name: '', phone: '', instagram: '', hometown: '' },
    error: null,
  });
});

// ---------------------------------------------------------------------------
// POST /pnms — create
//
// Multipart CSRF pattern: uploadPhoto (multer) runs first so it can parse
// the multipart body and populate req.body._csrf; csrfCheck then verifies
// that token explicitly, since the global csrfProtect in app.js skips
// multipart requests entirely (see middleware/guards.js for why).
// ---------------------------------------------------------------------------
router.post(
  '/',
  uploadPhoto,
  csrfCheck,
  asyncRoute(async (req, res) => {
    const isAdmin = req.user.role === 'admin';
    const body = req.body || {};
    const values = {
      name: body.name || '',
      phone: body.phone || '',
      instagram: body.instagram || '',
      hometown: body.hometown || '',
    };

    const rerender = (error) =>
      res.status(400).render('pnms/form', { mode: 'new', isAdmin, pnm: null, values, error });

    if (req.uploadError) return rerender(req.uploadError);

    const nameResult = validate.name(body.name);
    if (!nameResult.ok) return rerender(nameResult.error);

    const phoneResult = validate.phone(body.phone);
    if (!phoneResult.ok) return rerender(phoneResult.error);

    const instagramResult = validate.instagram(body.instagram);
    if (!instagramResult.ok) return rerender(instagramResult.error);

    const hometownResult = validate.hometown(body.hometown);
    if (!hometownResult.ok) return rerender(hometownResult.error);

    if (!isAdmin && !phoneResult.value && !instagramResult.value) {
      return rerender('Please provide a phone number or Instagram handle.');
    }

    let photoFilename = null;
    if (req.file) {
      const result = await processUpload(req.file.buffer);
      if (!result.ok) return rerender(result.error);
      photoFilename = result.filename;
    }

    const status = isAdmin ? 'active' : 'pending';

    const info = db
      .prepare(
        `INSERT INTO pnms (name, phone, instagram, hometown, photo, status, submitted_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        nameResult.value,
        phoneResult.value || null,
        instagramResult.value || null,
        hometownResult.value || null,
        photoFilename,
        status,
        req.user.id
      );

    if (isAdmin) {
      return res.redirect(`/pnms/${info.lastInsertRowid}`);
    }
    res.redirect('/pnms?submitted=1');
  })
);

// ---------------------------------------------------------------------------
// GET /pnms/:id/edit — must be registered before GET /pnms/:id
// ---------------------------------------------------------------------------
router.get('/:id/edit', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(404).send('Not found');

  const pnm = db.prepare('SELECT * FROM pnms WHERE id = ?').get(id);
  if (!pnm) return res.status(404).send('Not found');

  const isAdmin = req.user.role === 'admin';
  const isSubmitter = pnm.submitted_by === req.user.id;
  const canAccess = isAdmin || pnm.status === 'active' || isSubmitter;
  if (!canAccess) return res.status(404).send('Not found');

  res.render('pnms/form', {
    mode: 'edit',
    isAdmin,
    pnm,
    values: {
      name: pnm.name,
      phone: pnm.phone || '',
      instagram: pnm.instagram || '',
      hometown: pnm.hometown || '',
    },
    error: null,
  });
});

// ---------------------------------------------------------------------------
// POST /pnms/:id/edit — admin edits everything; brothers may only fill
// currently-blank optional fields. Enforced here server-side regardless of
// what the form rendered.
// ---------------------------------------------------------------------------
router.post(
  '/:id/edit',
  uploadPhoto,
  csrfCheck,
  asyncRoute(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(404).send('Not found');

    const pnm = db.prepare('SELECT * FROM pnms WHERE id = ?').get(id);
    if (!pnm) return res.status(404).send('Not found');

    const isAdmin = req.user.role === 'admin';
    const isSubmitter = pnm.submitted_by === req.user.id;
    const canAccess = isAdmin || pnm.status === 'active' || isSubmitter;
    if (!canAccess) return res.status(404).send('Not found');

    const body = req.body || {};
    const values = {
      name: isAdmin ? body.name || '' : pnm.name,
      phone: body.phone || '',
      instagram: body.instagram || '',
      hometown: body.hometown || '',
    };

    const rerender = (error) =>
      res.status(400).render('pnms/form', { mode: 'edit', isAdmin, pnm, values, error });

    if (req.uploadError) return rerender(req.uploadError);

    if (isAdmin) {
      const nameResult = validate.name(body.name);
      if (!nameResult.ok) return rerender(nameResult.error);

      const phoneResult = validate.phone(body.phone);
      if (!phoneResult.ok) return rerender(phoneResult.error);

      const instagramResult = validate.instagram(body.instagram);
      if (!instagramResult.ok) return rerender(instagramResult.error);

      const hometownResult = validate.hometown(body.hometown);
      if (!hometownResult.ok) return rerender(hometownResult.error);

      let photo = pnm.photo;
      let oldPhotoToDelete = null;
      if (req.file) {
        const result = await processUpload(req.file.buffer);
        if (!result.ok) return rerender(result.error);
        if (pnm.photo) oldPhotoToDelete = pnm.photo;
        photo = result.filename;
      } else if (body.remove_photo === '1' && pnm.photo) {
        oldPhotoToDelete = pnm.photo;
        photo = null;
      }

      db.prepare(
        `UPDATE pnms SET name = ?, phone = ?, instagram = ?, hometown = ?, photo = ? WHERE id = ?`
      ).run(
        nameResult.value,
        phoneResult.value || null,
        instagramResult.value || null,
        hometownResult.value || null,
        photo,
        id
      );

      // Only unlink the old file once the row update has committed, so a
      // failed UPDATE never leaves the DB pointing at a deleted photo.
      if (oldPhotoToDelete) deletePhoto(oldPhotoToDelete);

      return res.redirect(`/pnms/${id}`);
    }

    // Non-admin brother: fill-blanks-only. Any attempt to change a field
    // that already has a value is silently ignored (the stored value wins),
    // whether or not the form itself would have shown that input.
    let phone = pnm.phone;
    if (!pnm.phone) {
      const phoneResult = validate.phone(body.phone);
      if (!phoneResult.ok) return rerender(phoneResult.error);
      phone = phoneResult.value || null;
    }

    let instagram = pnm.instagram;
    if (!pnm.instagram) {
      const instagramResult = validate.instagram(body.instagram);
      if (!instagramResult.ok) return rerender(instagramResult.error);
      instagram = instagramResult.value || null;
    }

    let hometown = pnm.hometown;
    if (!pnm.hometown) {
      const hometownResult = validate.hometown(body.hometown);
      if (!hometownResult.ok) return rerender(hometownResult.error);
      hometown = hometownResult.value || null;
    }

    let photo = pnm.photo;
    if (!pnm.photo && req.file) {
      const result = await processUpload(req.file.buffer);
      if (!result.ok) return rerender(result.error);
      photo = result.filename;
    }

    db.prepare(`UPDATE pnms SET phone = ?, instagram = ?, hometown = ?, photo = ? WHERE id = ?`).run(
      phone,
      instagram,
      hometown,
      photo,
      id
    );

    res.redirect(`/pnms/${id}`);
  })
);

// ---------------------------------------------------------------------------
// POST /pnms/:id/vote — urlencoded body, covered by the global csrfProtect.
// ---------------------------------------------------------------------------
router.post('/:id/vote', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(404).send('Not found');

  const value = req.body && req.body.value;
  if (value !== 'yes' && value !== 'no') {
    return res.status(400).send('Invalid vote value.');
  }

  const pnm = db.prepare('SELECT id, status FROM pnms WHERE id = ?').get(id);
  if (!pnm) return res.status(404).send('Not found');
  if (pnm.status !== 'active') {
    return res.status(400).send('Voting is not open on this PNM.');
  }

  if (getSetting('voting_frozen') === '1') {
    return res.status(403).send('Voting is frozen.');
  }

  const numValue = value === 'yes' ? 1 : 0;
  db.prepare(
    `INSERT INTO votes (user_id, pnm_id, value, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, pnm_id) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  ).run(req.user.id, id, numValue);

  res.redirect(`/pnms/${id}`);
});

// ---------------------------------------------------------------------------
// Notes + reactions for the detail page.
//
// loadNotes: notes for a PNM, oldest first, joined with the author's
// CURRENT username/role (admin highlighting reflects role at render time,
// not at authorship time), each with a `reactions` summary attached.
//
// buildShowLocals: full local-variable set for views/pnms/show.ejs. Shared
// by GET /:id and the POST /:id/notes error re-render path (so an invalid
// note re-renders the same detail page instead of losing all its data).
// ---------------------------------------------------------------------------
function loadNotes(id, userId) {
  const notes = db
    .prepare(
      `SELECT n.*, u.username, u.role AS author_role
       FROM notes n
       JOIN users u ON u.id = n.user_id
       WHERE n.pnm_id = ?
       ORDER BY n.created_at ASC, n.id ASC`
    )
    .all(id);
  attachReactions(db, notes, userId);
  return notes;
}

function buildShowLocals(req, pnm, extra) {
  const isAdmin = req.user.role === 'admin';
  const isSubmitter = pnm.submitted_by === req.user.id;

  const tally = db
    .prepare(
      `SELECT
         SUM(CASE WHEN value = 1 THEN 1 ELSE 0 END) AS yes_count,
         SUM(CASE WHEN value = 0 THEN 1 ELSE 0 END) AS no_count
       FROM votes WHERE pnm_id = ?`
    )
    .get(pnm.id);

  const myVoteRow = db
    .prepare('SELECT value FROM votes WHERE pnm_id = ? AND user_id = ?')
    .get(pnm.id, req.user.id);

  const votingFrozen = getSetting('voting_frozen') === '1';
  const voteVisibility = getSetting('vote_visibility');
  const showVoters = voteVisibility === 'public' || isAdmin;

  let yesVoters = [];
  let noVoters = [];
  if (showVoters) {
    yesVoters = db
      .prepare(
        `SELECT u.username FROM votes v JOIN users u ON u.id = v.user_id
         WHERE v.pnm_id = ? AND v.value = 1 ORDER BY u.username COLLATE NOCASE`
      )
      .all(pnm.id)
      .map((r) => r.username);
    noVoters = db
      .prepare(
        `SELECT u.username FROM votes v JOIN users u ON u.id = v.user_id
         WHERE v.pnm_id = ? AND v.value = 0 ORDER BY u.username COLLATE NOCASE`
      )
      .all(pnm.id)
      .map((r) => r.username);
  }

  return Object.assign(
    {
      pnm,
      isAdmin,
      isSubmitter,
      decisionLabel,
      yesCount: tally.yes_count || 0,
      noCount: tally.no_count || 0,
      myVote: myVoteRow ? myVoteRow.value : null,
      votingFrozen,
      showVoters,
      yesVoters,
      noVoters,
      notes: loadNotes(pnm.id, req.user.id),
      noteError: null,
      noteBody: '',
    },
    extra
  );
}

// Same visibility rule used by GET /:id, GET /:id/edit, etc: active PNMs are
// open to any brother; pending/rejected ones only to the admin and the
// brother who submitted them.
function canAccessPnm(req, pnm) {
  const isAdmin = req.user.role === 'admin';
  const isSubmitter = pnm.submitted_by === req.user.id;
  return pnm.status === 'active' || isAdmin || isSubmitter;
}

// ---------------------------------------------------------------------------
// POST /pnms/:id/notes — add a note (1-2000 chars). Re-renders the detail
// page with an error on invalid input instead of redirecting, per plan.
// ---------------------------------------------------------------------------
router.post('/:id/notes', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(404).send('Not found');

  const pnm = db
    .prepare(
      `SELECT p.*, u.username AS submitted_by_username
       FROM pnms p
       LEFT JOIN users u ON u.id = p.submitted_by
       WHERE p.id = ?`
    )
    .get(id);
  if (!pnm) return res.status(404).send('Not found');
  if (!canAccessPnm(req, pnm)) return res.status(404).send('Not found');

  const rawBody = (req.body && req.body.body) || '';
  const result = validate.note(rawBody);
  if (!result.ok) {
    return res
      .status(400)
      .render(
        'pnms/show',
        buildShowLocals(req, pnm, { noteError: result.error, noteBody: rawBody })
      );
  }

  const info = db
    .prepare('INSERT INTO notes (pnm_id, user_id, body) VALUES (?, ?, ?)')
    .run(id, req.user.id, result.value);

  res.redirect(`/pnms/${id}#note-${info.lastInsertRowid}`);
});

// ---------------------------------------------------------------------------
// GET /pnms/:id — detail. Must be registered after /new and /:id/edit.
// ---------------------------------------------------------------------------
router.get('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(404).send('Not found');

  const pnm = db
    .prepare(
      `SELECT p.*, u.username AS submitted_by_username
       FROM pnms p
       LEFT JOIN users u ON u.id = p.submitted_by
       WHERE p.id = ?`
    )
    .get(id);

  if (!pnm) return res.status(404).send('Not found');

  if (!canAccessPnm(req, pnm)) {
    // Don't leak existence of a pending/rejected PNM to anyone else.
    return res.status(404).send('Not found');
  }

  res.render('pnms/show', buildShowLocals(req, pnm));
});

module.exports = router;
