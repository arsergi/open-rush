// End-to-end smoke tests: security/permission behavior across the whole
// app, run against a fresh temp SQLite DB + uploads dir.
//
// IMPORTANT: config.js reads env vars at require() time (dotenv + a
// SESSION_SECRET-required check), and db.js resolves DATA_DIR at require()
// time too. So DATA_DIR / SESSION_SECRET / COOKIE_SECURE must be set in
// process.env *before* requiring app.js or db.js anywhere in this file.
//
// Rate-limit note: routes/auth.js applies a single shared `authRateLimit`
// (10 requests / 15 min / IP) to both POST /login and POST /signup. All
// requests in this suite share one process (and therefore one IP), so we
// reuse a small number of long-lived, already-authenticated supertest
// agents across tests instead of calling the real POST /login flow for
// every test -- otherwise the suite would trip its own rate limiter. A
// fresh login is only performed where a test is specifically about a
// distinct identity (a new one-off user) or about the login flow itself.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'open-rush-test-'));
process.env.DATA_DIR = TMP_DIR;
process.env.SESSION_SECRET = 'test-secret-not-for-production-0123456789';
process.env.COOKIE_SECURE = '0';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const request = require('supertest');
const sharp = require('sharp');

const app = require('../app');
const { db, setSetting, UPLOADS_DIR } = require('../db');

// supertest, when handed the raw Express app function instead of a real
// listening server, spins up a brand-new http.createServer(app).listen(0)
// for EVERY single request (see supertest's Test#serverAddress). Doing
// that hundreds of times across this suite is a known source of
// intermittent socket flakiness (stale keep-alive sockets from an
// already-closed ephemeral server occasionally getting reused, producing
// a garbled "Expected HTTP/" parse error). Binding one real server once
// and pointing every request at it avoids that churn entirely.
let server;

const BCRYPT_COST = 12;
const PASSWORD = 'correcthorsebatterystaple';

function createUser({ email, username, role = 'brother', status = 'approved' }) {
  const hash = bcrypt.hashSync(PASSWORD, BCRYPT_COST);
  const info = db
    .prepare(
      `INSERT INTO users (email, username, password_hash, role, status)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(email, username, hash, role, status);
  return info.lastInsertRowid;
}

function insertActivePnm(name, submittedBy, phone) {
  const info = db
    .prepare(`INSERT INTO pnms (name, phone, status, submitted_by) VALUES (?, ?, 'active', ?)`)
    .run(name, phone, submittedBy);
  return info.lastInsertRowid;
}

// Extracts the _csrf hidden-input value from a rendered HTML page.
function extractCsrf(html) {
  const match = html.match(/name="_csrf"\s+value="([^"]+)"/);
  if (!match) throw new Error('Could not find _csrf token in page');
  return match[1];
}

async function getCsrfFor(agent, path_) {
  const res = await agent.get(path_);
  return extractCsrf(res.text);
}

// Logs an agent in via the real form flow (GET /login for the token, then
// POST /login), so subsequent requests on that agent carry the session
// cookie. Throws if login didn't actually succeed. Consumes one slot of the
// shared auth rate limiter -- see the file-level note above.
async function login(agent, username, password) {
  const csrf = await getCsrfFor(agent, '/login');
  const res = await agent.post('/login').type('form').send({ _csrf: csrf, username, password });
  assert.equal(res.status, 302, `login for ${username} should redirect (302), got ${res.status}`);
  return res;
}

let adminId, brotherId, pendingId;
let adminAgent, brotherAgent;

test.before(async () => {
  adminId = createUser({ email: 'admin@example.com', username: 'admin_user', role: 'admin', status: 'approved' });
  brotherId = createUser({ email: 'brother@example.com', username: 'brother_user', role: 'brother', status: 'approved' });
  pendingId = createUser({ email: 'pending@example.com', username: 'pending_user', role: 'brother', status: 'pending' });
  void pendingId;

  server = app.listen(0);

  adminAgent = request.agent(server);
  await login(adminAgent, 'admin_user', PASSWORD);

  brotherAgent = request.agent(server);
  await login(brotherAgent, 'brother_user', PASSWORD);
});

test.after(() => {
  try {
    server.close();
  } catch (_) {
    // ignore
  }
  try {
    db.close();
  } catch (_) {
    // ignore
  }
  fs.rmSync(TMP_DIR, { recursive: true, force: true });

  // better-sqlite3-session-store starts an un-refed-never setInterval (its
  // periodic expired-session sweep) with no handle exposed to stop it, so
  // the event loop never drains on its own once app.js has been required.
  // node --test then hangs forever after all tests report as passed. This
  // is purely a test-process-exit workaround (the real server is meant to
  // run forever, so the interval is correct there); it doesn't touch app
  // code or any security behavior. process.exitCode is already set by the
  // test runner to reflect pass/fail before this hook runs.
  process.exit(process.exitCode || 0);
});

// ---------------------------------------------------------------------------
// a. unauthenticated access
// ---------------------------------------------------------------------------
test('unauthenticated GET /pnms redirects to /login', async () => {
  const res = await request(server).get('/pnms');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/login');
});

// ---------------------------------------------------------------------------
// b. pending brother
// ---------------------------------------------------------------------------
test('pending brother can log in but GET /pnms redirects to /pending', async () => {
  const agent = request.agent(server);
  await login(agent, 'pending_user', PASSWORD);
  const res = await agent.get('/pnms');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/pending');
});

// ---------------------------------------------------------------------------
// c. approved brother
// ---------------------------------------------------------------------------
test('approved brother can GET /pnms (200) but not /admin (403)', async () => {
  const listRes = await brotherAgent.get('/pnms');
  assert.equal(listRes.status, 200);
  const adminRes = await brotherAgent.get('/admin');
  assert.equal(adminRes.status, 403);
});

// ---------------------------------------------------------------------------
// d. CSRF enforcement
// ---------------------------------------------------------------------------
test('POST /login without _csrf token is rejected with 403', async () => {
  const agent = request.agent(server);
  const res = await agent.post('/login').type('form').send({ username: 'brother_user', password: PASSWORD });
  assert.equal(res.status, 403);
});

test('POST vote without _csrf token is rejected with 403', async () => {
  const pnmId = insertActivePnm('CSRF Target', adminId, '5551234567');
  const res = await brotherAgent.post(`/pnms/${pnmId}/vote`).type('form').send({ value: 'yes' });
  assert.equal(res.status, 403);
});

// ---------------------------------------------------------------------------
// e. photo pipeline
// ---------------------------------------------------------------------------
test('photo pipeline: real JPEG is accepted, re-encoded, resized <= 800px', async () => {
  const jpegBuffer = await sharp({
    create: { width: 1200, height: 900, channels: 3, background: { r: 1, g: 2, b: 3 } },
  })
    .jpeg()
    .toBuffer();

  const csrf = await getCsrfFor(adminAgent, '/pnms/new');
  const before = new Set(fs.readdirSync(UPLOADS_DIR));

  const res = await adminAgent
    .post('/pnms')
    .field('_csrf', csrf)
    .field('name', 'Photo Test PNM')
    .field('phone', '5559876543')
    .attach('photo', jpegBuffer, { filename: 'photo.jpg', contentType: 'image/jpeg' });

  assert.equal(res.status, 302);

  const after = fs.readdirSync(UPLOADS_DIR);
  const newFiles = after.filter((f) => !before.has(f));
  assert.equal(newFiles.length, 1, 'expected exactly one new uploaded file');

  const storedPath = path.join(UPLOADS_DIR, newFiles[0]);
  const storedBuffer = fs.readFileSync(storedPath);

  // JPEG magic bytes: FF D8 FF
  assert.equal(storedBuffer[0], 0xff);
  assert.equal(storedBuffer[1], 0xd8);
  assert.equal(storedBuffer[2], 0xff);

  const metadata = await sharp(storedBuffer).metadata();
  assert.ok(metadata.width <= 800, `expected width <= 800, got ${metadata.width}`);
});

test('photo pipeline: non-image buffer named photo.png is rejected with 4xx, no file written', async () => {
  const csrf = await getCsrfFor(adminAgent, '/pnms/new');
  const before = new Set(fs.readdirSync(UPLOADS_DIR));

  const res = await adminAgent
    .post('/pnms')
    .field('_csrf', csrf)
    .field('name', 'Fake Image PNM')
    .field('phone', '5551112222')
    .attach('photo', Buffer.from('hello'), { filename: 'photo.png', contentType: 'image/png' });

  assert.ok(res.status >= 400 && res.status < 500, `expected 4xx, got ${res.status}`);

  const after = fs.readdirSync(UPLOADS_DIR);
  assert.deepEqual(after, [...before], 'no new file should have been written');
});

test('photo pipeline: fake JPEG magic bytes with garbage body fails gracefully (400, no crash)', async () => {
  const csrf = await getCsrfFor(adminAgent, '/pnms/new');
  const before = new Set(fs.readdirSync(UPLOADS_DIR));

  const garbage = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), crypto.randomBytes(200)]);

  const res = await adminAgent
    .post('/pnms')
    .field('_csrf', csrf)
    .field('name', 'Garbage Image PNM')
    .field('phone', '5553334444')
    .attach('photo', garbage, { filename: 'photo.jpg', contentType: 'image/jpeg' });

  assert.ok(res.status >= 400 && res.status < 500, `expected 4xx, got ${res.status}`);
  assert.match(res.text, /Could not process/);

  const after = fs.readdirSync(UPLOADS_DIR);
  assert.deepEqual(after, [...before], 'no new file should have been written');
});

// ---------------------------------------------------------------------------
// f. vote upsert
// ---------------------------------------------------------------------------
test('vote upsert: voting yes then no results in exactly one votes row with value 0', async () => {
  const pnmId = insertActivePnm('Vote Upsert PNM', adminId, '5550001111');

  let csrf = await getCsrfFor(brotherAgent, `/pnms/${pnmId}`);
  let res = await brotherAgent.post(`/pnms/${pnmId}/vote`).type('form').send({ _csrf: csrf, value: 'yes' });
  assert.equal(res.status, 302);

  csrf = await getCsrfFor(brotherAgent, `/pnms/${pnmId}`);
  res = await brotherAgent.post(`/pnms/${pnmId}/vote`).type('form').send({ _csrf: csrf, value: 'no' });
  assert.equal(res.status, 302);

  const rows = db.prepare('SELECT * FROM votes WHERE pnm_id = ? AND user_id = ?').all(pnmId, brotherId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value, 0);
});

// ---------------------------------------------------------------------------
// g. voting frozen
// ---------------------------------------------------------------------------
test('voting frozen: vote POST is rejected with 403 while frozen, restored after', async () => {
  const pnmId = insertActivePnm('Frozen Vote PNM', adminId, '5552223333');

  setSetting('voting_frozen', '1');
  try {
    const csrf = await getCsrfFor(brotherAgent, `/pnms/${pnmId}`);
    const res = await brotherAgent.post(`/pnms/${pnmId}/vote`).type('form').send({ _csrf: csrf, value: 'yes' });
    assert.equal(res.status, 403);
  } finally {
    setSetting('voting_frozen', '0');
  }
});

// ---------------------------------------------------------------------------
// h. signups closed
// ---------------------------------------------------------------------------
test('signups closed: POST /signup is rejected while closed, restored after', async () => {
  setSetting('signups_closed', '1');
  try {
    const agent = request.agent(server);
    // The signup page hides its whole form (including the _csrf hidden
    // input) when signups are closed -- see views/auth/signup.ejs -- so
    // there's no form to scrape a token from. The CSRF token lives on the
    // session, not the page, so any page render for this same agent (e.g.
    // /login) carries the same valid token.
    const csrf = await getCsrfFor(agent, '/login');
    const res = await agent.post('/signup').type('form').send({
      _csrf: csrf,
      email: 'newsignup@example.com',
      username: 'new_signup_user',
      password: 'somesecurepassword',
    });
    assert.equal(res.status, 403);
    const user = db.prepare('SELECT id FROM users WHERE email = ?').get('newsignup@example.com');
    assert.equal(user, undefined, 'no user should have been created');
  } finally {
    setSetting('signups_closed', '0');
  }
});

// ---------------------------------------------------------------------------
// i. PNM submission validation + visibility
// ---------------------------------------------------------------------------
test('PNM submission requires phone or instagram; instagram alone is enough and stays pending/private', async () => {
  // Neither phone nor instagram -> 400
  let csrf = await getCsrfFor(brotherAgent, '/pnms/new');
  let res = await brotherAgent.post('/pnms').type('form').send({ _csrf: csrf, name: 'No Contact PNM' });
  assert.equal(res.status, 400);

  // Instagram alone -> accepted, pending
  csrf = await getCsrfFor(brotherAgent, '/pnms/new');
  res = await brotherAgent
    .post('/pnms')
    .type('form')
    .send({ _csrf: csrf, name: 'Instagram Only PNM', instagram: 'somehandle' });
  assert.equal(res.status, 302);

  const pnm = db.prepare('SELECT * FROM pnms WHERE name = ?').get('Instagram Only PNM');
  assert.ok(pnm);
  assert.equal(pnm.status, 'pending');

  // A different, non-submitting brother cannot see it (404)
  createUser({ email: 'other_brother@example.com', username: 'other_brother', status: 'approved' });
  const otherAgent = request.agent(server);
  await login(otherAgent, 'other_brother', PASSWORD);
  const otherRes = await otherAgent.get(`/pnms/${pnm.id}`);
  assert.equal(otherRes.status, 404);

  // Admin can see it (200)
  const adminRes = await adminAgent.get(`/pnms/${pnm.id}`);
  assert.equal(adminRes.status, 200);
});

// ---------------------------------------------------------------------------
// j. note delete authorization
// ---------------------------------------------------------------------------
test('only the note author or an admin may delete a note', async () => {
  const pnmId = insertActivePnm('Notes Target PNM', adminId, '5554445555');

  let csrf = await getCsrfFor(brotherAgent, `/pnms/${pnmId}`);
  await brotherAgent.post(`/pnms/${pnmId}/notes`).type('form').send({ _csrf: csrf, body: 'A note written by brother_user' });

  const note = db.prepare('SELECT * FROM notes WHERE pnm_id = ?').get(pnmId);
  assert.ok(note);

  // A different brother cannot delete it -> 403
  createUser({ email: 'note_other@example.com', username: 'note_other', status: 'approved' });
  const otherAgent = request.agent(server);
  await login(otherAgent, 'note_other', PASSWORD);
  csrf = await getCsrfFor(otherAgent, `/pnms/${pnmId}`);
  let res = await otherAgent.post(`/notes/${note.id}/delete`).type('form').send({ _csrf: csrf });
  assert.equal(res.status, 403);

  const stillThere = db.prepare('SELECT id FROM notes WHERE id = ?').get(note.id);
  assert.ok(stillThere, 'note should still exist after unauthorized delete attempt');

  // The author can delete it -> 302, row gone
  csrf = await getCsrfFor(brotherAgent, `/pnms/${pnmId}`);
  res = await brotherAgent.post(`/notes/${note.id}/delete`).type('form').send({ _csrf: csrf });
  assert.equal(res.status, 302);

  const gone = db.prepare('SELECT id FROM notes WHERE id = ?').get(note.id);
  assert.equal(gone, undefined);
});

// ---------------------------------------------------------------------------
// j2. note replies: single-level threading only
// ---------------------------------------------------------------------------
test('a brother can reply to their own note, but replying to a reply is rejected', async () => {
  const pnmId = insertActivePnm('Reply Target PNM', adminId, '5554445556');

  let csrf = await getCsrfFor(brotherAgent, `/pnms/${pnmId}`);
  await brotherAgent.post(`/pnms/${pnmId}/notes`).type('form').send({ _csrf: csrf, body: 'A top-level note' });

  const note = db.prepare('SELECT * FROM notes WHERE pnm_id = ?').get(pnmId);
  assert.ok(note);

  // Same user replies to their own note -> 302, row inserted with parent_id set
  csrf = await getCsrfFor(brotherAgent, `/pnms/${pnmId}`);
  let res = await brotherAgent
    .post(`/notes/${note.id}/reply`)
    .type('form')
    .send({ _csrf: csrf, body: 'Replying to my own note' });
  assert.equal(res.status, 302);

  const reply = db.prepare('SELECT * FROM notes WHERE parent_id = ?').get(note.id);
  assert.ok(reply, 'reply should have been inserted');
  assert.equal(reply.parent_id, note.id);
  assert.equal(reply.user_id, brotherId);

  // Replying to the reply is rejected -> 400, no such row inserted
  csrf = await getCsrfFor(brotherAgent, `/pnms/${pnmId}`);
  res = await brotherAgent
    .post(`/notes/${reply.id}/reply`)
    .type('form')
    .send({ _csrf: csrf, body: 'Trying to reply to a reply' });
  assert.equal(res.status, 400);

  const nestedReply = db.prepare('SELECT * FROM notes WHERE parent_id = ?').get(reply.id);
  assert.equal(nestedReply, undefined, 'no reply-to-a-reply row should have been inserted');
});

// ---------------------------------------------------------------------------
// k. reaction validation + toggle
// ---------------------------------------------------------------------------
test('invalid reaction emoji rejected with 400; valid emoji toggles on then off', async () => {
  const pnmId = insertActivePnm('Reaction Target PNM', adminId, '5556667777');

  let csrf = await getCsrfFor(brotherAgent, `/pnms/${pnmId}`);
  await brotherAgent.post(`/pnms/${pnmId}/notes`).type('form').send({ _csrf: csrf, body: 'React to me' });
  const note = db.prepare('SELECT * FROM notes WHERE pnm_id = ?').get(pnmId);

  // Invalid emoji -> 400
  csrf = await getCsrfFor(brotherAgent, `/pnms/${pnmId}`);
  let res = await brotherAgent.post(`/notes/${note.id}/react`).type('form').send({ _csrf: csrf, emoji: '\u{1F4A9}' });
  assert.equal(res.status, 400);

  // Valid emoji -> toggles on
  csrf = await getCsrfFor(brotherAgent, `/pnms/${pnmId}`);
  res = await brotherAgent.post(`/notes/${note.id}/react`).type('form').send({ _csrf: csrf, emoji: '\u{1F44D}' });
  assert.equal(res.status, 302);

  let reactionRow = db
    .prepare("SELECT * FROM reactions WHERE note_id = ? AND user_id = ? AND emoji = ?")
    .get(note.id, brotherId, '\u{1F44D}');
  assert.ok(reactionRow, 'reaction should exist after first toggle');

  // Toggles off
  csrf = await getCsrfFor(brotherAgent, `/pnms/${pnmId}`);
  res = await brotherAgent.post(`/notes/${note.id}/react`).type('form').send({ _csrf: csrf, emoji: '\u{1F44D}' });
  assert.equal(res.status, 302);

  reactionRow = db
    .prepare("SELECT * FROM reactions WHERE note_id = ? AND user_id = ? AND emoji = ?")
    .get(note.id, brotherId, '\u{1F44D}');
  assert.equal(reactionRow, undefined, 'reaction should be gone after second toggle');
});

// ---------------------------------------------------------------------------
// l. admin approves pending user
// ---------------------------------------------------------------------------
test('admin approving a pending user lets them GET /pnms afterward', async () => {
  const toApproveId = createUser({
    email: 'toapprove@example.com',
    username: 'to_approve_user',
    status: 'pending',
  });

  const csrf = await getCsrfFor(adminAgent, '/admin/users');
  const res = await adminAgent.post(`/admin/users/${toApproveId}/approve`).type('form').send({ _csrf: csrf });
  assert.equal(res.status, 302);

  const updated = db.prepare('SELECT status FROM users WHERE id = ?').get(toApproveId);
  assert.equal(updated.status, 'approved');

  const newAgent = request.agent(server);
  await login(newAgent, 'to_approve_user', PASSWORD);
  const listRes = await newAgent.get('/pnms');
  assert.equal(listRes.status, 200);
});

// ---------------------------------------------------------------------------
// m. reset rush
// ---------------------------------------------------------------------------
test('POST /admin/reset requires exact confirmation text; wiping pnms keeps users', async () => {
  insertActivePnm('Reset Target PNM', adminId, '5558889999');

  // Wrong confirmation text -> 400, pnms intact
  let csrf = await getCsrfFor(adminAgent, '/admin/settings');
  let res = await adminAgent.post('/admin/reset').type('form').send({ _csrf: csrf, confirm: 'nope' });
  assert.equal(res.status, 400);
  let count = db.prepare('SELECT COUNT(*) AS n FROM pnms').get().n;
  assert.ok(count > 0, 'pnms should still exist after a failed reset attempt');

  const usersBefore = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

  // Correct confirmation -> pnms wiped, users intact
  csrf = await getCsrfFor(adminAgent, '/admin/settings');
  res = await adminAgent.post('/admin/reset').type('form').send({ _csrf: csrf, confirm: 'RESET RUSH' });
  assert.equal(res.status, 302);

  count = db.prepare('SELECT COUNT(*) AS n FROM pnms').get().n;
  assert.equal(count, 0);

  const usersAfter = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  assert.equal(usersAfter, usersBefore, 'user accounts should be untouched by reset');
});

// ---------------------------------------------------------------------------
// n. CSV formula-injection guard
// ---------------------------------------------------------------------------
test('CSV export guards a formula-injection PNM name with a leading apostrophe', async () => {
  insertActivePnm('=EVIL()', adminId, '5551239876');

  const res = await adminAgent.get('/admin/export.csv');
  assert.equal(res.status, 200);

  const dataLine = res.text.split('\r\n').find((line) => line.includes('EVIL'));
  assert.ok(dataLine, 'expected a CSV line containing the EVIL() name');
  assert.ok(
    dataLine.startsWith("'=EVIL()") || dataLine.startsWith('"\'=EVIL()"'),
    `expected cell to start with a guarded '= prefix, got: ${dataLine}`
  );
});
