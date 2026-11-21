// csv-fast: a fast drop-in for csv-reader 1.0.0 (make.fun's own CSV reader).
//
// Same answers, same errors, same order — read once, left to right, with
// commas and double quotes — but with indexOf-based segment scanning instead
// of one character at a time. The reference (vendor/csv-reader/index.js) is
// plain and easy to check, not fast: every field built up a character at a
// time. This module keeps its exact policy:
//
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside a quoted field a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled,
//     "" inside it is one quote and each CRLF or lone CR inside it is read as LF;
//     what follows its closing quote, up to the next comma or line break, is
//     appended as it stands (quote_junk, when the field ends);
//   - a quote that never closes is a literal character, and the text after it is
//     read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay strings,
//     never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds the
//     records after it (every record when header is false), each padded with ""
//     (short_row, with fields: its count) or cut (long_row, with extra: the cut
//     fields) to the first record's width;
//   - each error is {code, line, row}, in the order met: line the 1-based line its
//     record starts on (every LF, CRLF and lone CR inside a quoted field counted),
//     row its record's index in rows (null for the header).
//
// Speed comes from scanning segments, not characters: an unquoted field is one
// slice between the next comma and the next LF (two native indexOf calls), and
// a quoted field is one slice between its opening quote and the next quote that
// is not doubled. Only a field that actually holds a stray CR, or a quoted field
// that actually holds a line break, falls back to slower per-character work.
// Comparisons use charCodeAt, never string indexing; no regex runs anywhere.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  function err(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads unquoted characters from pos up to the next comma or line break, onto
  // `initial` (the value so far): a CR not followed by LF is dropped (stray_cr).
  // Returns the field and how it ended.
  function readUnquoted(initial) {
    const start = pos;
    const qComma = text.indexOf(',', start);
    const qLf = text.indexOf('\n', start);
    let q;
    let ended;
    if (qComma === -1) {
      if (qLf === -1) {
        q = len;
        ended = END;
      } else {
        q = qLf;
        ended = LINE_BREAK;
      }
    } else if (qLf === -1) {
      q = qComma;
      ended = COMMA;
    } else if (qComma < qLf) {
      q = qComma;
      ended = COMMA;
    } else {
      q = qLf;
      ended = LINE_BREAK;
    }
    const seg = text.slice(start, q);
    let value;
    if (seg.indexOf('\r') === -1) {
      value = initial === '' ? seg : initial + seg;
    } else {
      // Stray CRs: dropped, one stray_cr error each. A CR at the very end of a
      // segment that ends at LF is the CRLF line ending, not a stray CR.
      let body = seg;
      if (ended === LINE_BREAK && body.charCodeAt(body.length - 1) === 13) {
        body = body.slice(0, -1);
      }
      const firstCr = body.indexOf('\r');
      if (firstCr === -1) {
        // The only CR was the CRLF line ending: no stray CR at all.
        value = initial === '' ? body : initial + body;
      } else if (body.indexOf('\r', firstCr + 1) === -1) {
        // Exactly one stray CR: drop it with two slices, no split/join.
        err('stray_cr');
        const kept = body.slice(0, firstCr) + body.slice(firstCr + 1);
        value = initial === '' ? kept : initial + kept;
      } else {
        const parts = body.split('\r');
        for (let i = 1; i < parts.length; i++) err('stray_cr');
        const kept = parts.join('');
        value = initial === '' ? kept : initial + kept;
      }
    }
    pos = ended === END ? len : q + 1;
    if (ended === LINE_BREAK) line += 1;
    return { value, ended };
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    const start = pos + 1;
    let scan = start;
    let doubled = false;
    for (;;) {
      const q = text.indexOf('"', scan);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text after
        // it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        err('unterminated_quote');
        return readUnquoted('"');
      }
      if (text.charCodeAt(q + 1) === 34) {
        doubled = true;
        scan = q + 2;
        continue;
      }
      // Closing quote at q.
      const seg = text.slice(start, q);
      let value;
      if (seg.indexOf('\r') === -1 && seg.indexOf('\n') === -1) {
        value = doubled ? seg.split('""').join('"') : seg;
      } else {
        // A quoted field holding line breaks: each CRLF or lone CR inside it is
        // read as one LF, and each counts one line. Built in pieces and joined,
        // so a long field does not grow by one character at a time.
        const out = [];
        for (let i = 0; i < seg.length; i++) {
          const c = seg.charCodeAt(i);
          if (c === 13) {
            out.push('\n');
            line += 1;
            if (seg.charCodeAt(i + 1) === 10) i += 1;
          } else if (c === 10) {
            out.push('\n');
            line += 1;
          } else if (c === 34) {
            out.push('"');
            i += 1;
          } else {
            out.push(seg[i]);
          }
        }
        value = out.join('');
      }
      pos = q + 1;
      if (pos >= len) return { value, ended: END };
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        return { value, ended: COMMA };
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        return { value, ended: LINE_BREAK };
      }
      if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        return { value, ended: LINE_BREAK };
      }
      // What follows the closing quote is appended as it stands, up to the next
      // comma or line break.
      const junk = readUnquoted(value);
      if (junk.value.length > value.length) err('quote_junk');
      return junk;
    }
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;
    let ended;
    do {
      let f;
      if (text.charCodeAt(pos) === 34) {
        quoted = true;
        f = readQuoted();
      } else {
        quoted = false;
        f = readUnquoted('');
      }
      fields.push(f.value);
      ended = f.ended;
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
