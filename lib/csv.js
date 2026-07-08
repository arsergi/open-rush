// Minimal RFC 4180 CSV builder with a spreadsheet formula-injection guard.
//
// toCsv(rows) takes an array of rows, each row an array of cells (numbers,
// strings, null/undefined all accepted), and returns a single CSV string
// (CRLF line endings, trailing CRLF on the last row per RFC 4180).

// Any cell whose first character is one of these can be interpreted as a
// formula by Excel/Sheets/LibreOffice when the CSV is opened. Prefixing with
// a leading apostrophe forces it to be read as plain text.
const FORMULA_TRIGGER_RE = /^[=+\-@]/;

function guardFormula(cell) {
  return FORMULA_TRIGGER_RE.test(cell) ? `'${cell}` : cell;
}

function needsQuoting(cell) {
  return /[",\r\n]/.test(cell);
}

function escapeCell(value) {
  let cell = value === null || value === undefined ? '' : String(value);
  cell = guardFormula(cell);
  if (needsQuoting(cell)) {
    cell = `"${cell.replace(/"/g, '""')}"`;
  }
  return cell;
}

function toCsv(rows) {
  return rows.map((row) => row.map(escapeCell).join(',')).join('\r\n') + '\r\n';
}

module.exports = { toCsv };
