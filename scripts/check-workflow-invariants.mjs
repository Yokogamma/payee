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
 * Invariant C — a gate script that reads an Environment variable is never
 *   run without it. `check-gateways-vs-worker.mjs` reads VITE_STATUS_GATEWAYS
 *   and `check-trusted-owners.mjs` reads VITE_TRUSTED_OWNERS unless invoked
 *   with `--repo-only`; a `run:` step invoking either must carry that name
 *   in its own `env:` (or the job's). The 2026-09-07 dispatch of `5881da2`
 *   failed exactly here: the job split in #136 left the `env:` block on the
 *   NEIGHBOURING step, the gate saw an empty variable and refused a correct
 *   pool — a red deploy for a config that was right.
 *
 * Invariant D — every `${{ secrets.* }}` reference lives in a job that runs
 *   under an `environment:` (where the platform's deployment-branch policy
 *   applies) and only as `with.apiToken` or as an `env:` value of a `run:`
 *   step. The tokenless test-candidate job must never carry a secret, and a
 *   secret must never be an argument (`with.command`, `run:`).
 *
 * Invariant E — co-deployed secrets (`--secrets-file`) leave nothing behind.
 *   Wherever a `with.command` carries `--secrets-file <path>`: the path is
 *   under `${{ runner.temp }}` (outside the checkout), the SAME job has a
 *   `run:` step preparing it whose `env:` carries the secrets and whose text
 *   never echoes them, a LATER `if: always()` step in the same job removes
 *   that file, and no `actions/upload-artifact` step in that job names the
 *   file, its directory or `runner.temp`. A file that survived a failed
 *   deploy on a runner is the leak this guards against. HONEST LIMIT: the
 *   artifact rule matches the upload action's `with.path` only — a `run:`
 *   step that copies the file elsewhere before an upload, or exfiltrates it
 *   by any other means, is caught in review, not here.
 *
 * Invariant F — the tokenless jobs stay tokenless. TOKENLESS_JOBS names the
 *   jobs that run the CANDIDATE's own code (its tests, its lifecycle
 *   scripts): no `environment:` key and no `secrets.*` reference anywhere in
 *   them, whatever invariant D would otherwise allow. The boundary D
 *   promises («secrets only in the trusted deploy job») is only real if the
 *   untrusted job cannot be given an environment.
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
/** Any `${{ secrets.X }}` / `${{ secrets['X'] }}` reference (invariant D). */
const SECRETS_REF_RE = /\$\{\{[^}]*\bsecrets\s*[.[]/;
/** Invariant F: jobs that execute candidate code and must never see a secret. */
const TOKENLESS_JOBS = Object.freeze({ 'deploy-worker.yml': ['test-candidate'] });
/** The path may begin with an expression containing spaces: `${{ runner.temp }}/x`. */
const SECRETS_FILE_RE = /--secrets-file\s+((?:\$\{\{[^}]*\}\})?\S*)/;

/** Invariant C: gate script → the variables it reads. `repoOnly` names the
 *  gates that have a `--repo-only` mode (no Environment read, so no env: needed
 *  then); a gate without that mode is checked whatever flags its run: carries. */
const GATE_ENV = Object.freeze({
  'check-gateways-vs-worker.mjs': { variables: ['VITE_STATUS_GATEWAYS'], repoOnly: true },
  'check-trusted-owners.mjs': { variables: ['VITE_TRUSTED_OWNERS'], repoOnly: true },
  'check-client-floor-gate.mjs': { variables: ['WORKER_FLOOR_SHA', 'WORKER_CANDIDATE_SHA'], repoOnly: false },
});

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

    // Invariant C: every gate invocation carries the variable it reads.
    for (const [jobName, job] of Object.entries(doc.jobs ?? {})) {
      (job?.steps ?? []).forEach((step, i) => {
        const runText = typeof step?.run === 'string' ? step.run : '';
        for (const [script, { variables, repoOnly }] of Object.entries(GATE_ENV)) {
          if (!runText.includes(script)) continue;
          if (repoOnly && runText.includes('--repo-only')) continue;
          for (const variable of variables) {
            const carried = (step.env && variable in step.env) || (job.env && variable in job.env);
            if (!carried) {
              violations.push(
                `${name}: jobs.${jobName}.steps.${i} runs ${script} without ${variable} in env: — ` +
                  'the gate would judge an empty value and refuse a correct deploy',
              );
            }
          }
        }
      });
    }

    // Invariant D: secrets only under an environment, only in the two shapes.
    walkScalars(doc, [], (value, path) => {
      if (typeof value !== 'string' || !SECRETS_REF_RE.test(value)) return;
      const jobName = path[0] === 'jobs' ? path[1] : undefined;
      const job = jobName !== undefined ? doc.jobs?.[jobName] : undefined;
      const where = path.join('.');
      if (!job || job.environment === undefined) {
        violations.push(`${name}: secrets reference outside an environment-bound job — at ${where}`);
        return;
      }
      const step = path[2] === 'steps' && typeof path[3] === 'number' ? job.steps?.[path[3]] : undefined;
      const asApiToken = path.length === 6 && path[4] === 'with' && path[5] === 'apiToken';
      const asRunEnv = path.length === 6 && path[4] === 'env' && typeof step?.run === 'string';
      if (!asApiToken && !asRunEnv) {
        violations.push(
          `${name}: secrets reference must be with.apiToken or env: of a run: step — at ${where}`,
        );
      }
    });

    // Invariant E: --secrets-file is prepared in the job, kept in runner.temp, and removed always.
    for (const [jobName, job] of Object.entries(doc.jobs ?? {})) {
      (job?.steps ?? []).forEach((step, i) => {
        const command = typeof step?.with?.command === 'string' ? step.with.command : '';
        const m = SECRETS_FILE_RE.exec(command);
        if (!m) return;
        const file = m[1];
        const at = `${name}: jobs.${jobName}.steps.${i}`;
        if (!file.startsWith('${{ runner.temp }}/')) {
          violations.push(`${at}: --secrets-file must point under \${{ runner.temp }}, got ${file}`);
        }
        const basename = file.slice(file.lastIndexOf('/') + 1);
        const before = (job.steps ?? []).slice(0, i);
        const prep = before.find((s) => typeof s?.run === 'string' && s.run.includes(basename) && s.env && Object.keys(s.env).length > 0);
        if (!prep) {
          violations.push(`${at}: no earlier run: step in this job prepares ${basename} with secrets in env:`);
        } else if (/echo\s+"?\$CO_DEPLOY|cat\s+"?\$FILE|cat\s+"?\$RUNNER_TEMP/.test(prep.run)) {
          violations.push(`${at}: the preparing step prints the secrets file or a secret`);
        } else if (!/umask 077/.test(prep.run)) {
          violations.push(`${at}: the preparing step must set umask 077 before writing ${basename}`);
        }
        const after = (job.steps ?? []).slice(i + 1);
        const cleanup = after.find((s) => typeof s?.run === 'string' && s.run.includes(basename) && /\brm\s+-f\b/.test(s.run) && String(s.if ?? '').replace(/\s/g, '') === 'always()');
        if (!cleanup) {
          violations.push(`${at}: no later step with \`if: always()\` removes ${basename}`);
        }
        // No artifact may carry the file, its directory, or the whole temp dir.
        (job.steps ?? []).forEach((s, j) => {
          if (typeof s?.uses !== 'string' || !s.uses.startsWith('actions/upload-artifact')) return;
          const p = String(s.with?.path ?? '');
          if (p.includes(basename) || p.includes('runner.temp') || p.includes('RUNNER_TEMP')) {
            violations.push(`${name}: jobs.${jobName}.steps.${j} uploads an artifact that could carry ${basename} (path: ${p})`);
          }
        });
      });
    }

    // Invariant F: the tokenless jobs have no environment and no secrets reference at all.
    for (const jobName of TOKENLESS_JOBS[name] ?? []) {
      const job = doc.jobs?.[jobName];
      if (!job) {
        violations.push(`${name}: tokenless job ${jobName} is missing — the invariant cannot hold over a job that does not exist`);
        continue;
      }
      if (job.environment !== undefined) {
        violations.push(`${name}: tokenless job ${jobName} must not have an environment (it would gain access to Environment secrets)`);
      }
      walkScalars(job, ['jobs', jobName], (value, path) => {
        if (typeof value === 'string' && SECRETS_REF_RE.test(value)) {
          violations.push(`${name}: tokenless job ${jobName} references a secret — at ${path.join('.')}`);
        }
      });
    }

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
  console.log('✓ workflow invariants: 2 token carriers at with.apiToken, no ${{ }} in run:, gates carry their env, secrets only under environments, --secrets-file prepared/cleaned/never an artifact, tokenless jobs tokenless');
}
