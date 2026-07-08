// Photo upload pipeline: multer (memory storage) -> magic-byte sniff -> sharp
// re-encode -> write to disk. Client-supplied MIME type / filename extension
// are never trusted; only the actual bytes decide whether a file is an image.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const sharp = require('sharp');
const { UPLOADS_DIR } = require('../db');

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

const multerUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
});

// Sniffs the buffer's magic bytes to identify jpeg/png/webp. Returns null for
// anything else (including a .txt renamed to .png, etc).
function detectImageType(buffer) {
  if (!buffer || buffer.length < 4) return null;

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpeg';
  }

  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return 'png';
  }

  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'webp';
  }

  return null;
}

// Validates + re-encodes an uploaded image buffer and writes it to
// UPLOADS_DIR under a fresh random filename. Returns { ok: true, filename }
// or { ok: false, error }. Never trusts the original bytes beyond the magic
// number check; sharp re-encoding strips any embedded payload/EXIF.
async function processUpload(buffer) {
  const type = detectImageType(buffer);
  if (!type) {
    return { ok: false, error: 'File must be a JPEG, PNG, or WebP image.' };
  }

  let outBuffer;
  try {
    outBuffer = await sharp(buffer)
      .rotate()
      .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
  } catch (err) {
    return { ok: false, error: 'Could not process that image. Please try a different file.' };
  }

  const filename = `${crypto.randomUUID()}.jpg`;
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), outBuffer);
  return { ok: true, filename };
}

// Deletes a previously stored photo by filename. Ignores a missing file and
// refuses to touch anything that looks like a path (contains '/' or '..') --
// filenames we generate are always a bare crypto.randomUUID() + '.jpg'.
function deletePhoto(filename) {
  if (!filename || typeof filename !== 'string') return;
  if (filename.includes('/') || filename.includes('..')) return;

  try {
    fs.unlinkSync(path.join(UPLOADS_DIR, filename));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

// Route middleware: runs multer's single-file parse for field 'photo' and
// converts a file-too-large error into a friendly, recoverable form error
// (req.uploadError) instead of an unhandled exception / generic 500. Any
// other multer error is passed to the normal error handler.
function uploadPhoto(req, res, next) {
  multerUpload.single('photo')(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        req.uploadError = 'Photo must be 5MB or smaller.';
        return next();
      }
      return next(err);
    }
    next();
  });
}

module.exports = {
  MAX_FILE_SIZE,
  detectImageType,
  processUpload,
  deletePhoto,
  uploadPhoto,
};
