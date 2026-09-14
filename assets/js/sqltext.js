// ===========================================================================
//  SQL text utilities shared by the browser and the Node check suite.
//
//  Deliberately dependency-free and side-effect-free so that tools/ can import
//  it directly. Everything here is lexical -- it never asks the engine.
// ===========================================================================

/**
 * Split a script into individual statements on top-level semicolons.
 *
 * Semicolons are ignored inside single-quoted strings (with '' escapes),
 * double-quoted identifiers, dollar-quoted blocks, line comments and block
 * comments. Empty statements and comment-only fragments are dropped, so a
 * trailing semicolon or a trailing comment never produces a phantom statement.
 *
 * @param {string} sql
 * @returns {string[]} statements, each trimmed and without its terminator
 */
export function splitStatements(sql) {
  const src = String(sql ?? '');
  const out = [];
  let start = 0, i = 0;
  const n = src.length;

  while (i < n) {
    const ch = src[i];

    // line comment
    if (ch === '-' && src[i + 1] === '-') {
      i += 2;
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    // block comment (DuckDB does not nest these)
    if (ch === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    // single-quoted string; '' is an escaped quote
    if (ch === "'") {
      i++;
      while (i < n) {
        if (src[i] === "'") {
          if (src[i + 1] === "'") { i += 2; continue; }
          i++; break;
        }
        i++;
      }
      continue;
    }
    // double-quoted identifier; "" is an escaped quote
    if (ch === '"') {
      i++;
      while (i < n) {
        if (src[i] === '"') {
          if (src[i + 1] === '"') { i += 2; continue; }
          i++; break;
        }
        i++;
      }
      continue;
    }
    // dollar-quoted block: $tag$ ... $tag$
    if (ch === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i));
      if (m) {
        const tag = m[0];
        const end = src.indexOf(tag, i + tag.length);
        i = end === -1 ? n : end + tag.length;
        continue;
      }
    }
    if (ch === ';') {
      const piece = src.slice(start, i);
      if (hasCode(piece)) out.push(piece.trim());
      start = i + 1;
    }
    i++;
  }

  const tail = src.slice(start);
  if (hasCode(tail)) out.push(tail.trim());
  return out;
}

/** True when the fragment contains anything other than whitespace and comments. */
function hasCode(fragment) {
  return stripComments(fragment).trim().length > 0;
}

/** Remove line and block comments. Used for lexical inspection, never for execution. */
export function stripComments(sql) {
  return String(sql ?? '')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/**
 * True when a statement only reads. Used to decide whether a result grid is
 * expected, and to keep graded answers from modifying the database.
 */
export function isReadOnlyQuery(sql) {
  const head = stripComments(sql).trim().toUpperCase();
  return /^(SELECT|WITH|DESCRIBE|EXPLAIN|SHOW|PIVOT|UNPIVOT|SUMMARIZE|FROM|VALUES|TABLE)\b/.test(head);
}

/**
 * Escape a value for a CSV field, per RFC 4180: wrap in double quotes when it
 * contains a comma, a quote, or a newline, and double any embedded quote.
 * NULL becomes an empty, unquoted field so it is distinguishable from ''.
 */
export function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Render a { columns, rows } result as an RFC 4180 CSV string. */
export function toCSV({ columns, rows }) {
  const lines = [columns.map(csvCell).join(',')];
  for (const r of rows) lines.push(r.map(csvCell).join(','));
  return lines.join('\r\n');
}
