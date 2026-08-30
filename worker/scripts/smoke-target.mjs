/**
 * Shared fail-closed target classifier for the PAID smoke scripts
 * (smoke-v3.mjs, smoke-v4.mjs). Both post real, paid Arweave transactions,
 * so WHERE they point is a security decision, not a convenience:
 *
 *   - the smoke target is the WORKER API, never the Pages client origin —
 *     the client serves no /health or /upload (wrangler.toml records this:
 *     «the workers.dev URL is the API ENDPOINT, not a client origin»);
 *   - the FULL URL is classified, not just the hostname: a scheme dropped
 *     on the floor once let `http://<host>` pass as its https namesake;
 *   - http (plaintext) is allowed only for literal local loopback hosts
 *     (wrangler dev), and NEVER for remote targets — not even with an
 *     explicit grant: an escape hatch must not open a plaintext channel
 *     for a signed request;
 *   - https is auto-allowed only for the explicit worker origins below;
 *   - anything else needs SMOKE_ALLOW_ORIGIN=<exact https origin>. The
 *     grant is per-ORIGIN, not a boolean and not a hostname: a boolean
 *     once exported in a shell silently authorizes the NEXT, different
 *     target, and a host-only grant would leak to other ports;
 *   - targets are normalized: no credentials, no query/hash, root path
 *     only. Callers must build requests from the RETURNED origin
 *     (new URL('/upload', origin)), never by string-gluing SMOKE_URL.
 *
 * The allowlist lives HERE, in the repo, on purpose: these are public API
 * endpoints, not secrets, and reviewers must see every change to the list.
 */

// Plaintext http is acceptable only against these literal local hosts.
// The list is exact BY DESIGN: no IPv6 `[::1]`, no `*.localhost` — add a
// literal here consciously if you ever need one (and cover it in
// worker/test/smoke-target.test.ts).
const LOCAL_HTTP_HOSTNAMES = new Set(['localhost', '127.0.0.1']);

// Worker API origins the smokes may target WITHOUT an explicit grant.
//
//   - dev worker: verified 2026-08-20 (wrangler-action v4 rehearsal deploy +
//     /health). The same value stands behind the client's VITE_PROXY_URL —
//     this constant is the repo-pinned "expected value" the deploy config
//     gate compares against (plan §1.7): one source of truth.
//
//   - staging worker: NOT deployed yet, so NOT listed. Add its EXACT origin
//     (https://eternal-notes-proxy-staging.<acct>.workers.dev) in the same
//     change that provisions [env.staging] — until then a staging smoke
//     honestly requires SMOKE_ALLOW_ORIGIN. Leaving that state in place
//     long-term would train the operator to reach for the escape hatch
//     routinely, which is exactly the disease this module treats. Do NOT
//     pre-add a guessed value: the exact hostname exists only after the
//     first staging deploy.
export const AUTO_ALLOWED_WORKER_ORIGINS = Object.freeze([
  'https://eternal-notes-proxy.sopi-88c.workers.dev',
]);

/**
 * The deploy identity, pinned in the repository (PR-3a).
 *
 * `WORKER_NAME` and `ACCOUNT_ID` exist so a deploy smoke can prove it is
 * talking to the worker that was just deployed BY THESE CREDENTIALS, rather
 * than to whatever happens to answer at a hostname. Neither is a secret: the
 * account id is already an Actions variable and a wrangler var.
 */
export const WORKER_NAME = 'eternal-notes-proxy';
export const ACCOUNT_ID = '88cd072a3c0a9b861d52dcc126b9d57e';

/**
 * The App-Versions `/health` must advertise.
 *
 * Pinned HERE, deliberately, and not read from wrangler.toml — the list does
 * not exist there. It is hardcoded in the worker (`versions: ['1','2','3','4']`),
 * so the smoke needs its own independent expectation or it would be comparing
 * the worker against itself.
 */
export const EXPECTED_VERSIONS = Object.freeze(['1', '2', '3', '4']);

/**
 * Deploy profiles: what `/health` must say for a release to count as good.
 *
 * TWO EXACT capability ids, never «any» and never «missing». An emergency
 * build honestly declares that it carries the pre-quorum semantics and passes
 * ITS OWN profile; it cannot pass `normal`, and `normal` is the only profile
 * that opens the client release. That is what keeps the two apart without
 * relying on the candidate to describe itself favourably.
 *
 * The emergency profile additionally requires ALL THREE upload switches off —
 * checked before the deploy as well as after it, so an unsafe build cannot be
 * activated first and rejected second.
 */
export const DEPLOY_PROFILES = Object.freeze({
  normal: Object.freeze({
    statusQuorumPolicy: 'all-configured-v1',
    // The capability a client with import depends on (D2a): this build compares
    // a publication fingerprint before handing back a historical txId.
    //
    // Asserted by the smoke for the same reason `statusQuorumPolicy` is: the
    // release exists BECAUSE of this property, and a deploy that cannot prove it
    // shipped proves nothing at all. `undefined` under the emergency profile is
    // not an omission but the truthful value — an emergency build predates the
    // capability and must not appear to carry it.
    semanticIdempotency: 1,
    requireUploadsOff: false,
  }),
  emergency: Object.freeze({
    statusQuorumPolicy: 'legacy-single-v0',
    semanticIdempotency: undefined,
    requireUploadsOff: true,
  }),
});

/**
 * Parse and shape-check a URL that must denote a bare origin.
 * Returns { origin, protocol, hostname } or { error }.
 */
function bareOrigin(raw, label) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    return { error: `${label} is not a valid URL: ${raw}` };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { error: `${label} must be http(s), got ${u.protocol}` };
  }
  if (u.username !== '' || u.password !== '') {
    return { error: `${label} must not carry credentials` };
  }
  if (u.search !== '' || u.hash !== '') {
    return { error: `${label} must not carry a query or fragment` };
  }
  if (u.pathname !== '/') {
    return {
      error:
        `${label} must point at the origin root (pathname "/"), got "${u.pathname}" — ` +
        `requests are built from the origin, a path here would be silently dropped`,
    };
  }
  return { origin: u.origin, protocol: u.protocol, hostname: u.hostname };
}

function refusal(origin) {
  return `refusing to smoke a non-allow-listed target: ${origin}

  This script posts REAL, PAID Arweave transactions. Auto-allowed targets are
  the known worker API origins (AUTO_ALLOWED_WORKER_ORIGINS in
  worker/scripts/smoke-target.mjs) and local wrangler dev (http://localhost,
  http://127.0.0.1). The Pages client origin is NOT a smoke target: it serves
  neither /health nor /upload.

  Intentional exception? Re-run with SMOKE_ALLOW_ORIGIN=<exact https origin
  equal to the target's origin> and record why in docs/ROLLBACK.md. The grant
  is per-origin: it does not transfer to another host, port or scheme.`;
}

/**
 * Classify a smoke target. Pure: no process.env, no I/O.
 *
 * @param {string} rawUrl        SMOKE_URL as given by the operator
 * @param {string} [allowOrigin] SMOKE_ALLOW_ORIGIN, if set
 * @returns {{ ok: true, origin: string, warning?: string } |
 *           { ok: false, reason: string }}
 */
export function classifySmokeTarget(rawUrl, allowOrigin) {
  const target = bareOrigin(rawUrl, 'SMOKE_URL');
  if (target.error) return { ok: false, reason: target.error };

  if (target.protocol === 'http:') {
    if (LOCAL_HTTP_HOSTNAMES.has(target.hostname)) {
      return { ok: true, origin: target.origin };
    }
    // Remote plaintext is refused UNCONDITIONALLY — before the grant is even
    // looked at, so a matching SMOKE_ALLOW_ORIGIN cannot open the channel.
    return {
      ok: false,
      reason:
        `plaintext http is allowed only for ${[...LOCAL_HTTP_HOSTNAMES].join(', ')} — ` +
        `got ${target.origin}. Remote http is refused even with SMOKE_ALLOW_ORIGIN.`,
    };
  }

  if (AUTO_ALLOWED_WORKER_ORIGINS.includes(target.origin)) {
    return { ok: true, origin: target.origin };
  }

  if (allowOrigin === undefined || allowOrigin === null || allowOrigin === '') {
    return { ok: false, reason: refusal(target.origin) };
  }

  const grant = bareOrigin(allowOrigin, 'SMOKE_ALLOW_ORIGIN');
  if (grant.error) return { ok: false, reason: grant.error };
  if (grant.protocol !== 'https:') {
    return {
      ok: false,
      reason: 'SMOKE_ALLOW_ORIGIN must be an https origin — remote http is never allowed',
    };
  }
  if (grant.origin !== target.origin) {
    return {
      ok: false,
      reason:
        `SMOKE_ALLOW_ORIGIN (${grant.origin}) does not match the target (${target.origin}) — ` +
        `a grant is per-origin and does not transfer to another target`,
    };
  }
  return {
    ok: true,
    origin: target.origin,
    warning:
      `target ${target.origin} allowed via explicit SMOKE_ALLOW_ORIGIN — ` +
      `this is the escape hatch; record why in docs/ROLLBACK.md`,
  };
}
