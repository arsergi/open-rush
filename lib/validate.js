// Field validators shared across signup, PNM submission/edit, notes, etc.
// Every validator returns { ok: true, value } or { ok: false, error }.

const USERNAME_RE = /^[a-zA-Z0-9_]{3,30}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INSTAGRAM_RE = /^[a-zA-Z0-9._]{1,30}$/;

function username(value) {
  const trimmed = String(value || '').trim();
  if (!USERNAME_RE.test(trimmed)) {
    return {
      ok: false,
      error:
        'Username must be 3-30 characters and contain only letters, numbers, and underscores.',
    };
  }
  return { ok: true, value: trimmed };
}

function email(value) {
  const trimmed = String(value || '').trim();
  if (trimmed.length === 0 || trimmed.length > 254 || !EMAIL_RE.test(trimmed)) {
    return { ok: false, error: 'Please enter a valid email address.' };
  }
  return { ok: true, value: trimmed };
}

function password(value) {
  const raw = String(value || '');
  if (raw.length < 8) {
    return { ok: false, error: 'Password must be at least 8 characters.' };
  }
  return { ok: true, value: raw };
}

function name(value) {
  const trimmed = String(value || '').trim();
  if (trimmed.length === 0) {
    return { ok: false, error: 'Name is required.' };
  }
  if (trimmed.length > 100) {
    return { ok: false, error: 'Name must be 100 characters or fewer.' };
  }
  return { ok: true, value: trimmed };
}

function hometown(value) {
  const trimmed = String(value || '').trim();
  if (trimmed.length > 100) {
    return { ok: false, error: 'Hometown must be 100 characters or fewer.' };
  }
  return { ok: true, value: trimmed };
}

function note(value) {
  const trimmed = String(value || '').trim();
  if (trimmed.length === 0) {
    return { ok: false, error: 'Note cannot be empty.' };
  }
  if (trimmed.length > 2000) {
    return { ok: false, error: 'Note must be 2000 characters or fewer.' };
  }
  return { ok: true, value: trimmed };
}

function phone(value) {
  const trimmed = String(value || '').trim();
  if (trimmed.length > 20) {
    return { ok: false, error: 'Phone number must be 20 characters or fewer.' };
  }
  return { ok: true, value: trimmed };
}

function instagram(value) {
  let trimmed = String(value || '').trim();
  if (trimmed.startsWith('@')) {
    trimmed = trimmed.slice(1);
  }
  if (trimmed.length === 0) {
    return { ok: true, value: '' };
  }
  if (!INSTAGRAM_RE.test(trimmed)) {
    return {
      ok: false,
      error:
        'Instagram handle must be 1-30 characters: letters, numbers, periods, underscores.',
    };
  }
  return { ok: true, value: trimmed };
}

// Escapes %, _, and \ for safe use inside a LIKE pattern with ESCAPE '\'.
function escapeLike(value) {
  return String(value || '').replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

module.exports = {
  username,
  email,
  password,
  name,
  hometown,
  note,
  phone,
  instagram,
  escapeLike,
};
