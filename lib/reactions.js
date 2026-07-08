// Shared reaction-emoji constants + note-reaction aggregation, used by
// routes/pnms.js (rendering the notes list) and routes/notes.js (validating
// the emoji on POST /notes/:id/react). Keep the DB CHECK constraint on
// reactions.emoji as the backstop; this Set is the primary guard.

const EMOJIS = ['👍', '👎', '❤️', '🔥', '😂', '🦑'];
const EMOJI_SET = new Set(EMOJIS);

// Attaches a `reactions` array to each note: one entry per emoji, in fixed
// display order, each `{ emoji, count, mine }`. Mutates and returns the same
// notes array. `notes` must be objects with an `id` field (e.g. rows from
// the `notes` table).
function attachReactions(db, notes, userId) {
  if (notes.length === 0) return notes;

  const noteIds = notes.map((n) => n.id);
  const placeholders = noteIds.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT note_id, emoji, user_id FROM reactions WHERE note_id IN (${placeholders})`)
    .all(...noteIds);

  const byNote = new Map();
  for (const row of rows) {
    if (!byNote.has(row.note_id)) byNote.set(row.note_id, []);
    byNote.get(row.note_id).push(row);
  }

  for (const note of notes) {
    const noteRows = byNote.get(note.id) || [];
    note.reactions = EMOJIS.map((emoji) => {
      const matching = noteRows.filter((r) => r.emoji === emoji);
      return {
        emoji,
        count: matching.length,
        mine: matching.some((r) => r.user_id === userId),
      };
    });
  }

  return notes;
}

module.exports = { EMOJIS, EMOJI_SET, attachReactions };
