import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';

/**
 * Static guards (§8). Neither of these checks a behaviour: they exist because
 * two phrasings were examined, found wrong, and removed — and nothing except a
 * scanner stops them from being written again by somebody who never read the
 * argument against them. Both are absent from the tree TODAY, so both tests are
 * green on arrival; their whole value is the day they go red.
 *
 * ── Banned #1: «карантин с `txId` → no-op» ────────────────────────────────
 * The old import rule: a quarantined local row that carries a `txId` was left
 * alone. It is wrong twice over. «Can these bytes be read again?» and «may this
 * record be published?» are different questions, and the presence of a `txId`
 * answers neither: the normative source is the D5a table, which decides by
 * REASON and by whether the local record is readable (`backup-merge.ts`,
 * rule 1). Under the old formula a damaged record whose row happened to carry
 * a `txId` was skipped in silence — the backup held its bytes, the import
 * refused to write them, and the report still showed a full success, which is
 * exactly the state in which a user deletes their only copy.
 *
 * ── Banned #2: `last-export-at` / `last-verified-at` ──────────────────────
 * The original scalar freshness keys. Two global dates cannot say WHICH file
 * they describe, so exporting file A and verifying an older file B lit the chip
 * as though A had been verified. D21 replaced them with `last-export-artifact`
 * and `last-verified-artifact`, each carrying `{createdAt, sha256, at}`, and
 * the chip only claims «verified» when the two SHA-256 values match. A single
 * surviving reference to an old name — in code or in a fixture — is either dead
 * code or a second, unreconcilable source of truth about the same file.
 *
 * Comments are stripped before scanning (as in `backup-classify.test.ts`):
 * this file EXPLAINS both bans at length, and a scanner that reads prose would
 * fire on the explanation and then be relaxed until it caught nothing. The
 * stripping is itself asserted below, against this very file.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SELF = fileURLToPath(import.meta.url);

/**
 * `src/` (code, tests and fixtures), `docs/`, `scripts/` — the three roots §8
 * names — plus `viewer/`, the standalone reader of the same container, which is
 * code by every measure and costs nothing to include. `worker/` is out: it has
 * its own package tree, it never sees a client-local meta key, and its wholly
 * legitimate `txId` traffic would only be noise here.
 */
const SCAN_ROOTS = ['src', 'docs', 'scripts', 'viewer'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.wrangler', 'coverage']);
const TEXT_RE = /\.(?:[mc]?[jt]sx?|md|json|html|css)$/;

function* walkFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walkFiles(join(dir, entry.name));
    } else if (TEXT_RE.test(entry.name)) {
      yield join(dir, entry.name);
    }
  }
}

const scannedFiles = (): string[] => SCAN_ROOTS.flatMap((root) => [...walkFiles(join(ROOT, root))]);
const rel = (absolute: string) => relative(ROOT, absolute).split(sep).join(posix.sep);

/**
 * Markdown is left whole — in documentation the prose IS the statement, so a
 * banned formula written there is the thing being banned. Everywhere else the
 * comments go, replaced by blanks rather than deleted so that reported line
 * numbers still point at the real line. The `[^:]` before `//` keeps `https://`
 * from swallowing the rest of a line.
 */
function stripComments(relPath: string, source: string): string {
  if (relPath.endsWith('.md')) return source;
  if (relPath.endsWith('.html')) return source.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

type Hit = { file: string; line: number; text: string };

/** All matches of `pattern` in one file's non-comment text, minus those an
 *  optional `allowed` predicate forgives. Line-oriented: every pattern below is
 *  single-line by construction, and a hit is only useful with its address. */
function scanText(
  relPath: string,
  source: string,
  pattern: RegExp,
  allowed: (match: string) => boolean = () => false,
): Hit[] {
  const hits: Hit[] = [];
  stripComments(relPath, source).split(/\r?\n/).forEach((line, i) => {
    for (const m of line.matchAll(pattern)) {
      if (!allowed(m[0])) hits.push({ file: relPath, line: i + 1, text: m[0].trim() });
    }
  });
  return hits;
}

function scanTree(pattern: RegExp, allowed?: (match: string) => boolean): Hit[] {
  return scannedFiles().flatMap((file) => scanText(rel(file), readFileSync(file, 'utf8'), pattern, allowed));
}

// ── Guard 1: the quarantine/txId no-op formula ───────────────────────────────

const QUARANTINE = '(?:карантин\\p{L}*|quarantin\\p{L}*|terminal[\\s_]?error)';
const TX_ID = 'tx[\\s_-]?id';
const DOES_NOTHING = '(?:no[\\s-]?op\\p{L}*'
  + '|ничего не (?:дела|пиш|мен|происход)\\p{L}*'
  + '|не трога\\p{L}*'
  + '|остав\\p{L}+ как есть'
  + '|left (?:alone|untouched|as is)'
  + '|nothing (?:is written|happens|changes))';

/**
 * The pair in either order, close together, followed by a «does nothing»
 * verdict on the SAME line. Deliberately not a search for the exact sentence:
 * the formula returns as a paraphrase, in a test name or a doc line, long
 * before it returns verbatim.
 */
const QUARANTINE_TXID_NOOP = new RegExp(
  `(?:${QUARANTINE}[^\\n]{0,48}?${TX_ID}|${TX_ID}[^\\n]{0,48}?${QUARANTINE})[^\\n]{0,64}?${DOES_NOTHING}`,
  'giu',
);

/**
 * …and the one sentence that must stay writable: the DENIAL. «A quarantined row
 * with a txId is NOT a no-op» is how the correct rule is explained, and a guard
 * that forbids its own rationale gets deleted within a week. The escape is
 * narrow — a negator inside the matched span, nothing more — and it is the
 * documented way through: state the rule as a denial, or do not state it.
 */
const NEGATED = /(?<!\p{L})(?:не|нет|not|never|no longer|вместо|rather than)(?!\p{L})/iu;

/**
 * A denial has a negator OUTSIDE the verdict it denies — and the first version
 * of this predicate did not check that.
 *
 * The banned phrasings contain their own «не»: «карантин с txId ничего не
 * меняет» is the formula itself, positively asserted, and a bare search for a
 * negator anywhere in the span forgave it. That is a false NEGATIVE in a guard
 * whose entire job is to fire — the worst kind, because it is invisible until
 * the day the formula comes back.
 *
 * So the verdict is removed from the span first. What is left is the subject
 * («карантин с txId …»), and a negator surviving there is a real denial:
 * «карантин с txId — это НЕ no-op».
 */
const isDenial = (match: string) => NEGATED.test(match.replace(new RegExp(DOES_NOTHING, 'giu'), ' '));

/**
 * …and the second escape, which the first version of this guard lacked and
 * which made it report ITSELF: an IDENTIFIER is not a statement.
 *
 * `QUARANTINE_TXID_NOOP` is the name of the pattern that bans the formula, and
 * a guard that cannot be named after the thing it guards against is a guard
 * that has to be renamed into vagueness. The rule is mechanical and narrow:
 * a banned STATEMENT is prose, and prose has spaces in it. A run of characters
 * with no whitespace at all is a name — of a constant, a test id, a CSS class —
 * and names assert nothing.
 */
const isIdentifier = (match: string) => !/\s/.test(match);
const allowedFormula = (match: string) => isDenial(match) || isIdentifier(match);

// ── Guard 2: the retired scalar freshness keys ───────────────────────────────

/**
 * `last-export-at`, `last-verified-at` and their camel/screaming spellings.
 * A space is NOT accepted as a separator on purpose: «the file was last
 * verified at 12:00» is ordinary English, not a key reference. The current
 * `-artifact` names cannot match — after `last-export-` comes `ar`, not `at` —
 * and that is asserted below rather than assumed.
 */
const OLD_FRESHNESS_KEY = /last[-_]?(?:export|verified)[-_]?at(?![\p{L}\p{N}_-])/giu;

// ── Samples the scanners must catch, assembled at run time ───────────────────

/**
 * Stored back-to-front, one fragment per line: the banned text must never exist
 * contiguously in this file, or the guard would report itself and every future
 * reader would have to decide whether that hit is «the real one». Reassembled
 * below, the fragments are the banned phrasings exactly.
 */
const POISON_RU = ['no-op', 'карантин с ', 'txId → '] as const;
const POISON_EN = ['no-op', 'a quarantined record that carries a ', 'txId is a '] as const;
const POISON_KEY_TAIL = 'at';
const POISON_KEY_HEADS = ['last-export', 'last-verified'] as const;

const bannedFormulas = [
  POISON_RU[1] + POISON_RU[2] + POISON_RU[0],
  POISON_EN[1] + POISON_EN[2] + POISON_EN[0],
];
const bannedKeys = [
  `${POISON_KEY_HEADS[0]}-${POISON_KEY_TAIL}`,
  `${POISON_KEY_HEADS[1]}-${POISON_KEY_TAIL}`,
  `last${'Export'}${'At'}`,
  `LAST_VERIFIED_${'AT'}`,
];

describe('the retired «quarantined + txId» formula stays out of the tree', () => {
  it('no file states that a quarantined record with a txId does nothing', () => {
    // The failure this catches is not a wrong test — it is a rule written back
    // into the product. Under it, bytes that exist in the backup are not
    // written to a record the user can no longer read, and the import still
    // reports a clean success; the user then deletes the file.
    expect(scanTree(QUARANTINE_TXID_NOOP, allowedFormula)).toEqual([]);
  });

  it('the scanner sees the formula when it is actually there', () => {
    // An always-green scanner is worse than none: it is a claim nobody
    // re-checks. So the check is run against this file's own text with the
    // banned sentence appended — the experiment of «write it back in and see»,
    // made permanent instead of done once by hand.
    for (const formula of bannedFormulas) {
      const poisoned = `${readFileSync(SELF, 'utf8')}\nconst returned = '${formula}';\n`;
      expect(scanText(rel(SELF), poisoned, QUARANTINE_TXID_NOOP, allowedFormula)).toHaveLength(1);
    }
  });

  it('and does not see it in this file, which explains it at length', () => {
    // The other half of the same proof: without comment stripping the header
    // above would be a permanent hit, and the only way to green would be to
    // weaken the pattern until it matched nothing.
    expect(scanText(rel(SELF), readFileSync(SELF, 'utf8'), QUARANTINE_TXID_NOOP, allowedFormula)).toEqual([]);
  });

  it('a name is not a statement — the guard may be named after what it guards', () => {
    // The gap that made the first version of this file report itself nine
    // times over. Without this escape the only way to green is to rename every
    // constant and every test id until nothing in the repository is allowed to
    // SAY what is forbidden — which is how a guard becomes unreadable and then
    // gets deleted.
    expect(scanText('x.ts', 'const QUARANTINE_TXID_NOOP = 1;', QUARANTINE_TXID_NOOP, allowedFormula)).toEqual([]);
    // A sentence with the same words is still a hit: the space is the whole
    // difference between naming a rule and asserting one. The sentence is
    // assembled from the fragments above rather than written out — spelled
    // contiguously it would sit in this file forever and the tree scan would
    // report it, which is the trap this very test exists to describe.
    expect(scanText('x.ts', bannedFormulas[1], QUARANTINE_TXID_NOOP, allowedFormula)).toHaveLength(1);
  });

  it('a positive statement is NOT excused by the «не» inside its own verdict', () => {
    // The false negative this closes. Every Russian «does nothing» phrasing
    // carries a «не» — «ничего не меняет», «ничего не пишет» — so a negator
    // search over the whole span forgave the formula in its most natural
    // wording, and the guard was quietly asleep.
    // Assembled, never written out: spelled contiguously these would sit in
    // this file forever and the tree scan would report them — the same trap
    // the banned formulas above are built from fragments to avoid.
    const subject = `${POISON_RU[1]}txId `;
    const positives = ['ничего не меняет', 'ничего не пишет', 'ничего не происходит']
      .map(verdict => `${subject}${verdict}`);
    for (const line of positives) {
      expect(scanText('x.ts', line, QUARANTINE_TXID_NOOP, allowedFormula), line).toHaveLength(1);
    }
  });

  it('the correct rule may still be stated as a denial', () => {
    // Named explicitly so the escape hatch is a decision, not an accident: the
    // reason the formula is banned has to be sayable in the file that bans it.
    const denials = [
      'карантин с txId — это НЕ no-op: решение принимает таблица D5a',
      'карантин с txId — не тот случай, когда ничего не меняется',
      'a quarantined row that carries a txId is not a no-op',
    ];
    for (const line of denials) expect(scanText('x.ts', line, QUARANTINE_TXID_NOOP, allowedFormula)).toEqual([]);
    // But only because of the denial — strip it and the same sentence is a hit.
    const english = denials.find(d => d.includes(' not '))!;
    expect(scanText('x.ts', english.replace(' not', ''), QUARANTINE_TXID_NOOP, allowedFormula))
      .toHaveLength(1);
  });

  it('the merge rules cannot consult a txId: outside their comments they never name one', () => {
    // The strongest form of the same ban. A decision cannot depend on a value
    // the module never reads, so this is not a phrasing check but a structural
    // one — and it is why the D5a table stays the single source of the verdict.
    // Mentions in the prose are expected (the ban is explained there too);
    // a read in the code is the thing that must not appear.
    const source = readFileSync(join(ROOT, 'src/lib/backup-merge.ts'), 'utf8');
    const code = stripComments('src/lib/backup-merge.ts', source);

    expect(code).toMatch(/terminalError/); // reading the right file
    expect(code).not.toMatch(/tx[\s_-]?id/i);
  });
});

describe('the retired scalar freshness keys stay retired', () => {
  it('no code, test or fixture names the old global export/verify dates', () => {
    // What comes back with these names is the false pairing D21 removed:
    // exported file A, verified file B, one green chip that says «this export
    // is verified». The names are gone, so any occurrence is either dead weight
    // or a second answer to a question that must have exactly one.
    expect(scanTree(OLD_FRESHNESS_KEY)).toEqual([]);
  });

  it('the scanner sees each retired spelling when it is actually there', () => {
    // Same permanent poisoning experiment, one run per spelling: a scanner that
    // only knows the dashed form would wave a `lastExportAt` field straight
    // through, and a field is exactly how the value would come back.
    for (const key of bannedKeys) {
      const poisoned = `${readFileSync(SELF, 'utf8')}\nconst returned = '${key}';\n`;
      expect(scanText(rel(SELF), poisoned, OLD_FRESHNESS_KEY)).toHaveLength(1);
    }
  });

  it('the names in force today are not mistaken for the retired ones', () => {
    // If the pattern hit `last-export-artifact` the guard would be permanently
    // red and would be deleted rather than fixed; and the adapter is read here
    // so that a rename of the CURRENT keys cannot leave this file quietly
    // guarding two names nobody uses.
    const adapter = readFileSync(join(ROOT, 'src/lib/backup-adapter.ts'), 'utf8');
    expect(adapter).toContain('last-export-artifact');
    expect(adapter).toContain('last-verified-artifact');
    expect(scanText('backup-adapter.ts', adapter, OLD_FRESHNESS_KEY)).toEqual([]);
  });
});

describe('the scanners are alive', () => {
  it('the walk reaches code, docs, scripts, the viewer and this file itself', () => {
    // Both guards assert an EMPTY result, which an unbrowsed tree produces for
    // free. This is the test that says the emptiness was earned. This file is
    // in the list on purpose: it is scanned like any other, and is exempt from
    // nothing.
    const files = scannedFiles().map(rel);

    expect(files).toContain('src/lib/backup-merge.ts');
    expect(files).toContain('docs/BACKUP_FORMAT_V1.md');
    expect(files).toContain('scripts/build-backup-viewer.mjs');
    expect(files).toContain('viewer/main.ts');
    expect(files).toContain(rel(SELF));
    expect(files.length).toBeGreaterThan(100);
  });

  it('a comment is stripped from code and kept in documentation', () => {
    // The asymmetry is load-bearing for both guards, so it is stated once here
    // instead of being inferred from a green run: prose in a .md file is a
    // statement about the product, prose in a .ts file explains the code it
    // sits next to.
    const line = `// ${bannedFormulas[0]}`;
    expect(scanText('a.ts', line, QUARANTINE_TXID_NOOP, allowedFormula)).toEqual([]);
    expect(scanText('a.md', line, QUARANTINE_TXID_NOOP, allowedFormula)).toHaveLength(1);
  });

  it('stripping a block comment keeps the line numbers of what follows', () => {
    // A hit is actionable only at an address. Block comments are blanked, not
    // removed, so the report points at the offending line and not at a line
    // some number of comment rows earlier.
    const file = `/**\n * prose\n * prose\n */\nconst returned = '${bannedKeys[0]}';\n`;
    expect(scanText('a.ts', file, OLD_FRESHNESS_KEY)).toEqual([
      { file: 'a.ts', line: 5, text: bannedKeys[0] },
    ]);
  });
});
