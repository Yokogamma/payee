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
 * In particular the QUOTED and DOTTED spellings TOML allows for the same
 * tables and keys — `["vars"]`, `[env."staging".vars]`, `"KEY" = …`,
 * `a.b = …` — are refused outright: wrangler would read them, the bare-name
 * scanner would not, and the two would then judge different files.
 */

/** Thrown on syntax this scanner refuses to interpret. */
export class TomlScanError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TomlScanError';
  }
}

// BARE names only — no quotes, no spaces inside a segment. TOML also allows
// `["vars"]`, `[env."staging".vars]`, `"KEY" = …` and `a.b = …`; wrangler
// reads all of those as the same tables and keys this scanner spells bare. A
// scanner that recognised the bare form and silently ignored the others would
// let a candidate declare the value wrangler ACTUALLY uses in a spelling the
// gate never looks at. So the quoted and dotted forms are not «unsupported» —
// they are REFUSED, and the gate fails closed on the whole file.
const TABLE_RE = /^\[\[?([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)\]\]?\s*(#.*)?$/;
const KEY_RE = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/;

const DQ3 = '"'.repeat(3);
const SQ3 = "'".repeat(3);

/**
 * Walk one line outside a multi-line string and report the net change in
 * bracket depth (`[`/`{` minus `]`/`}`) OUTSIDE strings and comments — the
 * only way to tell a continuation line of a multi-line array from a line the
 * scanner does not understand. Also reports whether a multi-line string opens
 * on this line without closing.
 */
function scanLine(line, depth) {
  let i = 0;
  let opensMultiline = null;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '#') break;
    if (ch === '"' || ch === "'") {
      const triple = line.slice(i, i + 3);
      if (triple === DQ3 || triple === SQ3) {
        const close = line.indexOf(triple, i + 3);
        if (close < 0) { opensMultiline = triple; break; }
        i = close + 3;
        continue;
      }
      // single-line string: skip to its close, honouring escapes in basic strings
      let j = i + 1;
      while (j < line.length && line[j] !== ch) {
        if (ch === '"' && line[j] === '\\') j++;
        j++;
      }
      if (j >= line.length) throw new TomlScanError(`unterminated string: ${line.trim()}`);
      i = j + 1;
      continue;
    }
    if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') depth--;
    i++;
  }
  return { depth, opensMultiline };
}

/**
 * Split `text` into table sections.
 *
 * Every line is classified, and a line that fits NONE of the shapes below is a
 * refusal — never skipped:
 *   - blank, or a comment;
 *   - a bare table header `[a.b]` / `[[a.b]]`;
 *   - a bare-key assignment `key = value`;
 *   - a continuation line of a multi-line array/inline-table value;
 *   - a line inside a multi-line string, which is inert.
 */
function sections(text) {
  const out = [{ table: '', lines: [] }];
  let inMultiline = null; // the delimiter that opened it
  let depth = 0;          // bracket depth of an unfinished value

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

    if (depth > 0) {
      // Continuation of a multi-line array. Only the bracket bookkeeping
      // matters here; the value itself is never one the gates read.
      const r = scanLine(line, depth);
      depth = r.depth;
      if (r.opensMultiline) inMultiline = r.opensMultiline;
      if (depth < 0) throw new TomlScanError(`unbalanced brackets: ${trimmed}`);
      continue;
    }

    const table = TABLE_RE.exec(trimmed);
    if (table) {
      out.push({ table: table[1], lines: [] });
      continue;
    }
    if (trimmed.startsWith('[')) {
      throw new TomlScanError(`table header in a form this scanner refuses (quoted or malformed): ${trimmed}`);
    }

    const key = KEY_RE.exec(trimmed);
    if (!key) {
      throw new TomlScanError(`line is neither a bare table header nor a bare-key assignment: ${trimmed}`);
    }
    const r = scanLine(key[2], 0);
    depth = r.depth;
    if (r.opensMultiline) inMultiline = r.opensMultiline;
    if (depth < 0) throw new TomlScanError(`unbalanced brackets: ${trimmed}`);
    out[out.length - 1].lines.push(trimmed);
  }

  if (inMultiline !== null) throw new TomlScanError('unterminated multi-line string');
  if (depth !== 0) throw new TomlScanError('unterminated array or inline table');
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
