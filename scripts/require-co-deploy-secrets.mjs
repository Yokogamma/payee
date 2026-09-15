// NO SHEBANG: imported by its test (see no-shebang-in-imported-mjs.test.mjs).
/**
 * «Secret required» mode of the trusted worker deploy (deploy-worker.yml,
 * docs/SECRETS.md «Co-deployed secrets»).
 *
 * The `required_secrets` workflow input names the worker secrets that MUST be
 * in the co-deploy file, or the rotation the run was dispatched for did not
 * happen. Parsing it in shell (`IFS=',' read -ra … <<< "$X"`) reads the FIRST
 * LINE only — a value such as "\nCF_ANALYTICS_TOKEN" yields an empty list and
 * the run degrades silently into an ordinary deploy without the secret. So
 * the input is parsed here, strictly, and anything but a clean comma list of
 * registered names is a refusal BEFORE anything is uploaded.
 *
 * This script never sees a secret value: the workflow hands it the NAMES of
 * the keys present in the file (`jq -c 'keys'`) and starts it with every
 * CO_DEPLOY_* variable removed from the environment (`env -u`), so the value
 * is absent from this process, not merely unread by it.
 */

/** The co-deploy registry — one entry per `CO_DEPLOY_<NAME>` env in the
 *  preparing step and per row in docs/SECRETS.md. Kept in sync by
 *  check-workflow-invariants.test.mjs. */
export const CO_DEPLOY_REGISTRY = Object.freeze(['CF_ANALYTICS_TOKEN']);

const NAME_RE = /^[A-Z][A-Z0-9_]*$/;

/**
 * Pure. `rawRequired` is the workflow input verbatim; `presentNames` the keys
 * of the co-deploy file; `registry` the names that may be required at all.
 * Returns { ok, required, problems } — `problems` names every reason.
 */
export function checkRequiredSecrets(rawRequired, presentNames, registry = CO_DEPLOY_REGISTRY) {
  const problems = [];
  const raw = rawRequired ?? '';
  if (typeof raw !== 'string') return { ok: false, required: [], problems: ['required_secrets is not a string'] };
  if (raw === '') return { ok: true, required: [], problems: [] };
  if (/[\r\n]/.test(raw)) problems.push('required_secrets contains a line break — only the first line would have been read by a shell parser; refusing the whole value');
  if (/\s/.test(raw)) problems.push('required_secrets contains whitespace — pass a plain comma-separated list');
  const parts = raw.split(',');
  const required = [];
  parts.forEach((part, i) => {
    if (part === '') { problems.push(`required_secrets has an empty element at position ${i + 1}`); return; }
    if (!NAME_RE.test(part)) { problems.push(`required_secrets element "${part}" is not a secret name ([A-Z][A-Z0-9_]*)`); return; }
    if (!registry.includes(part)) { problems.push(`required_secrets names "${part}", which is not in the co-deploy registry (${registry.join(', ')})`); return; }
    if (required.includes(part)) { problems.push(`required_secrets names "${part}" twice`); return; }
    required.push(part);
  });
  if (!Array.isArray(presentNames) || !presentNames.every(n => typeof n === 'string')) {
    problems.push('present secret names are not a list of strings');
  } else {
    for (const name of required) {
      if (!presentNames.includes(name)) problems.push(`required co-deploy secret ${name} is not set in the Environment — refusing to deploy a rotation without it`);
    }
  }
  return { ok: problems.length === 0, required, problems };
}

// ── CLI (the workflow step) ─────────────────────────────────────────
if (process.argv[1]?.endsWith('require-co-deploy-secrets.mjs')) {
  let present;
  try {
    present = JSON.parse(process.env.PRESENT_SECRET_NAMES ?? 'null');
  } catch {
    present = null;
  }
  const result = checkRequiredSecrets(process.env.REQUIRED_SECRETS ?? '', present);
  if (!result.ok) {
    console.error('✗ required co-deploy secrets:');
    for (const p of result.problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(result.required.length
    ? `✓ required co-deploy secrets present: ${result.required.join(', ')}`
    : '✓ no co-deploy secret required for this dispatch');
}
