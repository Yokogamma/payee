// NO SHEBANG here: this module is imported by its test, and a `#!` first line
// breaks the vite-node build silently (see no-shebang-in-imported-mjs.test.mjs).
/**
 * Static workflow invariants (§1.7). Runs inside the ROOT vitest suite on
 * every PR (check-workflow-invariants.test.mjs asserts the real
 * .github/workflows/ tree is clean) and is available as a CLI for local use.
 *
 * Invariant A — the deploy token has exactly two legitimate carriers.
 *   Parse every workflow with js-yaml, walk ALL scalar values, and find the
 *   ones containing the identifier CLOUDFLARE_API_TOKEN in ANY syntax
 *   (`${{ secrets.X }}`, `${{secrets.X}}`, `${{ secrets['X'] }}`, …).
 *   Requirements:
 *     - exactly TWO carriers;
 *     - each at jobs.<job>.steps[<i>].with.apiToken;
 *     - that step's `uses` is cloudflare/wrangler-action pinned to a
 *       40-hex commit SHA (a movable tag would run foreign code WITH the
 *       token).
 *   Comments are dropped by the parser, so header mentions pass; docs
 *   outside .github/workflows/ are not scanned at all.
 *
 * Invariant B — no `${{ }}` inside any `run:` scalar, in any workflow.
 *   The expression is expanded TEXTUALLY before the shell starts, so any
 *   third-party value lands directly on the command line. Such values go
 *   through `env:` and are dereferenced as "$VAR".
 *
 * HONEST LIMIT (do not oversell this check): it catches syntax variation,
 * not deliberate obfuscation — e.g. an identifier assembled via format().
 * That class is caught in review, not statically. It also lives in the
 * same branch as the workflows: a malicious commit can delete check and
 * workflow together. The real boundary is the deployment branch policy on
 * the `dev` environment plus the platform rulesets (§1.0b); this check
 * catches accidental regressions early and loudly.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';

const TOKEN_IDENTIFIER = 'CLOUDFLARE_API_TOKEN';
const WRANGLER_ACTION_SHA_RE = /^cloudflare\/wrangler-action@[0-9a-f]{40}$/;
const EXPRESSION_RE = /\$\{\{[\s\S]*?\}\}/;

/** Recursively visit every scalar with its path. */
function walkScalars(node, path, visit) {
  if (node === null || node === undefined) return;
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
    visit(node, path);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, i) => walkScalars(item, [...path, i], visit));
    return;
  }
  if (typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      walkScalars(value, [...path, key], visit);
    }
  }
}

/**
 * Pure core. files: Array<{ name, content }> (YAML sources).
 * Returns { ok, violations, carriers } — carriers listed for reporting.
 */
export function checkWorkflowInvariants(files) {
  const violations = [];
  const carriers = [];

  for (const { name, content } of files) {
    let doc;
    try {
      doc = load(content);
    } catch (e) {
      violations.push(`${name}: YAML parse error: ${e.message}`);
      continue;
    }
    if (!doc || typeof doc !== 'object') continue;

    walkScalars(doc, [], (value, path) => {
      if (typeof value !== 'string') return;

      // Invariant A: collect token carriers wherever the identifier appears.
      if (value.includes(TOKEN_IDENTIFIER)) {
        carriers.push({ file: name, path });
      }

      // Invariant B: no expressions inside run: scalars.
      if (path[path.length - 1] === 'run' && EXPRESSION_RE.test(value)) {
        violations.push(
          `${name}: \`\${{ }}\` inside run: at ${path.join('.')} — ` +
            `pass the value via env: and dereference it as "$VAR"`,
        );
      }
    });

    // Invariant A shape check for carriers found in THIS file.
    for (const carrier of carriers.filter((c) => c.file === name)) {
      const p = carrier.path;
      const shapeOk =
        p.length === 6 &&
        p[0] === 'jobs' &&
        p[2] === 'steps' &&
        typeof p[3] === 'number' &&
        p[4] === 'with' &&
        p[5] === 'apiToken';
      if (!shapeOk) {
        violations.push(
          `${name}: ${TOKEN_IDENTIFIER} outside with.apiToken — at ${p.join('.')}`,
        );
        continue;
      }
      const step = doc.jobs?.[p[1]]?.steps?.[p[3]];
      const uses = step?.uses;
      if (typeof uses !== 'string' || !WRANGLER_ACTION_SHA_RE.test(uses)) {
        violations.push(
          `${name}: the step carrying ${TOKEN_IDENTIFIER} must be ` +
            `cloudflare/wrangler-action pinned to a 40-hex SHA, got: ${uses ?? '(none)'}`,
        );
      }
    }
  }

  if (carriers.length !== 2) {
    violations.push(
      `expected exactly 2 carriers of ${TOKEN_IDENTIFIER} across workflows, found ${carriers.length}` +
        (carriers.length
          ? `: ${carriers.map((c) => `${c.file}:${c.path.join('.')}`).join('; ')}`
          : ''),
    );
  }

  return { ok: violations.length === 0, violations, carriers };
}

/** Load every workflow file from a directory. */
export function loadWorkflowFiles(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => ({ name: f, content: readFileSync(join(dir, f), 'utf8') }));
}

// ── CLI ──────────────────────────────────────────────────────────────
if (process.argv[1]?.endsWith('check-workflow-invariants.mjs')) {
  const dir = process.argv[2] ?? '.github/workflows';
  const { ok, violations } = checkWorkflowInvariants(loadWorkflowFiles(dir));
  if (!ok) {
    console.error('✗ workflow invariants failed:');
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
  }
  console.log('✓ workflow invariants: 2 token carriers at with.apiToken, no ${{ }} in run:');
}
