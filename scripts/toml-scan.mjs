/**
 * A minimal TOML SCANNER for the deploy gates.
 *
 * Not a parser, and not a substring search either. `toml.indexOf('[vars]')`
 * is exploitable: a candidate can put the text `[vars]` inside a multi-line
 * string of some other table and leave the REAL `[vars]` unsafe, and the gate
 * reads the decoy. The same trick hides behind comments and `#` in strings.
 *
 * Dependency-free on purpose: these gates run BEFORE `npm ci` — that is the
 * whole point of an early gate — so pulling in a TOML library is not an option.
 * The subset below is exactly what `wrangler.toml` uses:
 *
 *   - table headers `[a.b]` and `[[a.b]]`, recognised only at line start,
 *     outside strings and comments;
 *   - `key = "value"` with basic strings, including escapes;
 *   - `'''` / `\"\"\"` multi-line strings, whose contents are INERT;
 *   - `#` comments outside strings.
 *
 * Anything it cannot understand is a REFUSAL, never a guess: a gate that
 * silently skips what it fails to parse is a gate that can be talked past.
 */

/** Thrown on syntax this scanner refuses to interpret. */
export class TomlScanError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TomlScanError';
  }
}

const TABLE_RE = /^\[\[?([A-Za-z0-9_.\-"' ]+)\]\]?\s*(#.*)?$/;
const KEY_RE = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/;

/**
 * Split `text` into table sections, ignoring anything inside multi-line
 * strings. Returns `[{ table, lines }]`; the root section has `table: ''`.
 */
function sections(text) {
  const out = [{ table: '', lines: [] }];
  let inMultiline = null; // the delimiter that opened it

  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.replace(/\r$/, '');

    if (inMultiline !== null) {
      // Inside a multi-line string EVERYTHING is inert — including text that
      // looks exactly like a table header. That is the bypass this closes.
      if (line.includes(inMultiline)) inMultiline = null;
      continue;
    }

    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    // A line that OPENS a multi-line string without closing it on the same line.
    for (const delim of ['"""', "'''"]) {
      const first = line.indexOf(delim);
      if (first >= 0 && line.indexOf(delim, first + 3) < 0) {
        inMultiline = delim;
        break;
      }
    }
    if (inMultiline !== null) continue;

    const table = TABLE_RE.exec(trimmed);
    if (table) {
      out.push({ table: table[1].trim(), lines: [] });
      continue;
    }
    out[out.length - 1].lines.push(trimmed);
  }

  if (inMultiline !== null) throw new TomlScanError('unterminated multi-line string');
  return out;
}

/**
 * Read `key` from table `table` (use `''` for the root).
 *
 * A DUPLICATE table is a refusal rather than a merge: TOML forbids redefining
 * a table, and tolerating it here would let a candidate append a second
 * `[vars]` whose values the gate reads while wrangler reads the first — or the
 * other way round. Refusing is the only answer that cannot be gamed.
 */
export function readTomlString(text, table, key) {
  const all = sections(text);
  const matching = all.filter(s => s.table === table);
  if (matching.length === 0) return { error: `missing table [${table || 'root'}]` };
  if (matching.length > 1) {
    return { error: `table [${table || 'root'}] is declared ${matching.length} times` };
  }

  const found = [];
  for (const line of matching[0].lines) {
    const m = KEY_RE.exec(line);
    if (!m || m[1] !== key) continue;
    const value = m[2].trim();
    // Only basic strings: the gates compare exact literals, and quietly
    // accepting a bare/number/array value would compare something else.
    const quoted = /^"((?:[^"\\]|\\.)*)"\s*(#.*)?$/.exec(value);
    if (!quoted) return { error: `${key} in [${table || 'root'}] is not a basic string` };
    found.push(quoted[1].replace(/\\(.)/g, '$1'));
  }

  if (found.length === 0) return { error: `missing ${key} in [${table || 'root'}]` };
  if (found.length > 1) return { error: `${key} in [${table || 'root'}] is declared twice` };
  return { value: found[0] };
}
