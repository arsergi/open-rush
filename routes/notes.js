const express = require('express');
const { db } = require('../db');
const { EMOJI_SET } = require('../lib/reactions');
const validate = require('../lib/validate');

const router = express.Router();

// Mounted at /notes behind requireApproved in app.js, so every handler
// below can assume req.user is a logged-in, approved user.

const getNoteWithPnmStmt = db.prepare(
  `SELECT n.*, p.status AS pnm_status, p.submitted_by AS pnm_submitted_by
   FROM notes n
   JOIN pnms p ON p.id = n.pnm_id
   WHERE n.id = ?`
);

// Same visibility rule as the PNM detail page: active PNMs are open to any
// brother; pending/rejected ones only to the admin and the submitter.
function canSeeNotePnm(req, note) {
  const isAdmin = req.user.role === 'admin';
  const isSubmitter = note.pnm_submitted_by === req.user.id;
  return note.pnm_status === 'active' || isAdmin || isSubmitter;
}

// ---------------------------------------------------------------------------
// POST /notes/:id/delete — author or admin only.
// ---------------------------------------------------------------------------
router.post('/:id/delete', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(404).send('Not found');

  const note = getNoteWithPnmStmt.get(id);
  if (!note || !canSeeNotePnm(req, note)) return res.status(404).send('Not found');

  const isAdmin = req.user.role === 'admin';
  if (note.user_id !== req.user.id && !isAdmin) {
    return res.status(403).send('Forbidden');
  }

  // Reactions cascade via the FK ON DELETE CASCADE on reactions.note_id.
  db.prepare('DELETE FROM notes WHERE id = ?').run(id);

  res.redirect(`/pnms/${note.pnm_id}`);
});

// ---------------------------------------------------------------------------
// POST /notes/:id/react — toggle a reaction: delete the row if it already
// exists for this user+note+emoji, otherwise insert it. Emoji is validated
// against the fixed 6-emoji set here; the reactions.emoji CHECK constraint
// in the schema is a backstop, not the primary guard.
// ---------------------------------------------------------------------------
router.post('/:id/react', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(404).send('Not found');

  const emoji = req.body && req.body.emoji;
  if (typeof emoji !== 'string' || !EMOJI_SET.has(emoji)) {
    return res.status(400).send('Invalid emoji.');
  }

  const note = getNoteWithPnmStmt.get(id);
  if (!note || !canSeeNotePnm(req, note)) return res.status(404).send('Not found');

  const existing = db
    .prepare('SELECT id FROM reactions WHERE note_id = ? AND user_id = ? AND emoji = ?')
    .get(id, req.user.id, emoji);

  if (existing) {
    db.prepare('DELETE FROM reactions WHERE id = ?').run(existing.id);
  } else {
    db.prepare('INSERT INTO reactions (note_id, user_id, emoji) VALUES (?, ?, ?)').run(
      id,
      req.user.id,
      emoji
    );
  }

  res.redirect(`/pnms/${note.pnm_id}#note-${id}`);
});

// ---------------------------------------------------------------------------
// POST /notes/:id/reply — reply to a top-level note (1-2000 chars, same
// validation as a note). Single-level only: replying to a reply is rejected.
// ---------------------------------------------------------------------------
router.post('/:id/reply', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(404).send('Not found');

  const parent = getNoteWithPnmStmt.get(id);
  if (!parent || !canSeeNotePnm(req, parent)) return res.status(404).send('Not found');
  if (parent.parent_id !== null) return res.status(400).send('Cannot reply to a reply.');

  const result = validate.note((req.body && req.body.body) || '');
  if (!result.ok) return res.status(400).send(result.error);

  const info = db
    .prepare('INSERT INTO notes (pnm_id, user_id, parent_id, body) VALUES (?, ?, ?, ?)')
    .run(parent.pnm_id, req.user.id, id, result.value);

  res.redirect(`/pnms/${parent.pnm_id}#note-${info.lastInsertRowid}`);
});

module.exports = router;
