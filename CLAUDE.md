# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

open-rush is a self-hostable rush tracking app for a fraternity chapter: brothers submit/browse potential new members (PNMs), vote yes/no, leave notes with emoji reactions, and an admin approves accounts/PNMs, records bid decisions, and exports a CSV. It is deliberately a plain server-rendered app — one Node process, one SQLite file, no build step, no client-side JS framework, and it works with JavaScript disabled in the browser. Keep changes consistent with that: no bundler, no SPA framework, no client-side JS dependency for core functionality.

## Commands

```bash
npm install              # install dependencies
npm test                 # run the full test suite (node's built-in test runner)
node --test test/smoke.test.js   # run just the smoke test file
node --test --test-name-pattern="reply"  # run tests whose name matches a pattern
npm start                # run the app (needs .env with SESSION_SECRET set — cp .env.example .env)
npm run create-admin     # create an admin account via CLI (the only way to create one)
```

There is no build step, linter, or type checker configured — `npm test` is the only CI-relevant command.

There is one test file, `test/smoke.test.js`: end-to-end HTTP tests (via `supertest`) against the real Express app and a fresh temp SQLite DB, covering permission/security behavior (who can see/edit/delete what) across the whole app. When adding a route or changing an authorization rule, add or extend a test here rather than starting a new test file — the existing one already sets up shared logged-in agents (see below) that most new tests can reuse.

Test file quirks worth knowing before editing it:
- `DATA_DIR` / `SESSION_SECRET` / `COOKIE_SECURE` env vars are set at the top of the file *before* `app.js`/`db.js` are required, because both read env vars at `require()` time.
- Tests share a small number of long-lived, already-authenticated `supertest` agents (`brotherAgent`, `adminAgent`, etc.) instead of logging in fresh each time, because `/login` and `/signup` share one rate limiter and the whole suite runs as one IP. Only log in fresh when a test is specifically about a distinct identity or the login flow itself.
- The suite binds one real `http.createServer` and points every request at it, rather than letting `supertest` spin up a fresh ephemeral server per request (which is the default when you hand it an Express app directly) — that pattern was a source of flaky socket errors.
- `test.after` calls `process.exit` because `better-sqlite3-session-store`'s cleanup sweep interval never unrefs, which would otherwise hang the process after tests finish.

## Architecture

**Request flow (see `app.js`):** `helmet` → `express.urlencoded` → session (SQLite-backed via `better-sqlite3-session-store`) → static `/public` → `loadUser` → `csrfProtect` → route mounts. Routes are mounted with their auth gate at the mount point, not inside each handler: `/pnms` and `/notes` require `requireApproved`, `/admin` requires `requireAdmin`, `/uploads` (serving PNM photos) also requires `requireApproved` since photos aren't public assets. `requireApproved`/`requireAdmin`/`loadUser` live in `middleware/guards.js`.

**Auth model:** signup is open (unless admin closes it) but new accounts start `pending` and see nothing until an admin approves them at `/admin/users`. There are two roles (`brother`, `admin`) and three user statuses (`pending`, `approved`, `rejected`). **Admin accounts can only be created/promoted via `scripts/admin.js`, run on the server itself — there is no HTTP route that can grant the `admin` role.** Don't add one.

**CSRF:** a per-session synchronizer token, checked with a timing-safe comparison (`middleware/guards.js`). The global `csrfProtect` middleware runs before any route-level body parsing, so it can only validate `application/x-www-form-urlencoded` bodies — for `multipart/form-data` (photo upload) routes it skips the check and the route itself must re-run `csrfCheck` *after* its own `multer` middleware has parsed the body. Every new multipart POST route must follow this `multer → csrfCheck → handler` ordering (see `routes/pnms.js` for the existing example). Every form needs a hidden `_csrf` field.

**PNM visibility rule**, applied consistently in multiple places (`routes/pnms.js`, `routes/notes.js`): a PNM is visible to any approved brother once `status = 'active'`; while `pending`/`rejected` it's visible only to its submitter and admins. Notes/replies inherit this rule via a join back to their parent PNM (`canSeeNotePnm` in `routes/notes.js`) rather than having their own independent visibility check — keep that pattern if you add more PNM-scoped data.

**Field-editing rule:** brothers can only fill in currently-blank optional PNM fields (hometown, phone, Instagram, photo) when editing; admins can edit anything. This is enforced server-side per field, not just hidden in the UI.

**Notes:** flat notes plus single-level replies (a note can have replies; a reply cannot itself be replied to — enforced in `routes/notes.js` by checking `parent.parent_id !== null`). `routes/pnms.js`'s `loadNotes()` queries all notes+replies for a PNM in one flat query, runs `attachReactions` (`lib/reactions.js`) over the flat list, then groups replies under their parent in memory. Rendering reuses one partial, `views/partials/note.ejs`, for both a top-level note and a reply — extend that partial rather than duplicating markup if you touch note rendering.

**Reactions:** a fixed 6-emoji set (`lib/reactions.js`), toggled on/off per user per note/reply, backed by a `UNIQUE(note_id, user_id, emoji)` constraint. The emoji set is validated against `EMOJI_SET` in the route handler; the DB `CHECK` constraint is a backstop, not the primary guard.

**Photo pipeline** (`lib/photos.js`): `multer` (memory storage) → sniff actual magic bytes (never trust client-supplied MIME type or filename extension) → re-encode + resize through `sharp` (strips EXIF/any embedded payload) → write to disk under a fresh random filename. Only the app's own re-encoded files are ever served back.

**Database** (`db.js`): a single `better-sqlite3` connection, schema created via `CREATE TABLE IF NOT EXISTS` in one `db.exec(...)` block at require time — there's no separate migration runner. Because `IF NOT EXISTS` won't add new columns to an already-deployed DB, schema changes that add a column need an explicit migration guard alongside it, e.g.:
```js
const cols = db.prepare('PRAGMA table_info(notes)').all();
if (!cols.some((c) => c.name === 'parent_id')) {
  db.exec('ALTER TABLE notes ADD COLUMN parent_id INTEGER REFERENCES notes(id) ON DELETE CASCADE');
}
```
All access goes through parameterized statements — no string-built SQL. Search input goes through `validate.escapeLike` before use in a `LIKE` pattern.

**Validation** (`lib/validate.js`): every field validator returns `{ ok: true, value }` or `{ ok: false, error }`, shared across signup, PNM submit/edit, and notes/replies. Follow that return shape for new validators.

**Settings/reset:** chapter-wide settings (`vote_visibility`, `voting_frozen`, `signups_closed`) live in a `settings` key/value table (`getSetting`/`setSetting` in `db.js`), not env vars — they're admin-editable at runtime. `/admin/settings` also has a "reset rush" danger zone (wipes PNMs/votes/notes/reactions/photos, requires typing `RESET RUSH`, leaves user accounts intact).

**Config vs. settings:** `config.js` (env-var-backed: `PORT`, `DATA_DIR`, `SESSION_SECRET`, `COOKIE_SECURE`, `TRUST_PROXY`) is read once at process start and requires `SESSION_SECRET` to be set or the process throws immediately — don't make new deploy-time config admin-editable through the `settings` table, and don't make per-chapter behavior toggles env vars.

**Error handling:** the global error handler in `app.js` fails closed — it only echoes the real error message when `NODE_ENV === 'development'`, and shows a generic message otherwise (including when `NODE_ENV` is unset). Don't leak error details to the client outside that explicit dev check.

## Security posture

This is a from-scratch security posture worth preserving, not re-deriving per change (see README's "Security notes" for the user-facing summary): bcrypt cost 12 with a dummy-hash comparison on login for unknown accounts (timing safety), Helmet with a strict `default-src 'self'` CSP, per-IP rate limiting on login/signup, magic-byte-sniffed + re-encoded photo uploads, parameterized SQL everywhere, CSV export with formula-injection guarding (leading `'` on cells starting with `=+-@`), and no HTTP path to the `admin` role. New routes/features should fit inside this model rather than introducing a parallel one (e.g. a new file upload path should reuse `lib/photos.js`'s pipeline, not add a second one).
