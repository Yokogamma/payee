/**
 * Eternal Notes — Cloudflare Worker Proxy
 *
 * Handles Arweave uploads (server pays AR), invite registration,
 * and registration checks. Auth via Ed25519 signature + server-side allowlist.
 */

import Arweave from 'arweave';
import * as ed25519 from '@noble/ed25519';
import { readAllowCache } from './allowlist';
// CROSS-HALF IMPORT (deliberate): the quorum formula and the gateway parser
// are the CLIENT's modules, imported here so there is exactly one
// implementation of each. Both are pure, env-free and DOM-free — the wrangler
// bundle picks them up as plain TypeScript. Precedent: worker/test/
// client-parity.test.ts already imports src/lib/crypto.ts.
import { parseOriginList, serializeStatusOrigins } from '../../src/lib/gateways-parse';
import { QUORUM_POLICY_ID, statusVerdict, type StatusVote } from '../../src/lib/status-quorum';
import { parseTrustedOwners } from '../../src/lib/trusted-owners';
import { authenticatePublication } from './publication-auth';
import { computePublicationFp } from './publication-fp';
import type { LegacySnapshot } from './rate-limiter';
import {
  ARWEAVE_HOST,
  assertStructurallyCompleteJwk,
  classifyStatus,
  classifyThrow,
  getAnchor,
  getArweave,
  getPrice,
  postSignedTx,
  readCappedText,
} from './arweave-transport';
import {
  buildMetricsReportSql,
  makeEmit,
  METRICS_DATASET_RE,
  METRICS_REPORTS,
  type Emit,
  type MetricsReport,
} from './metrics';

export { RateLimiter } from './rate-limiter';
export { InviteManager } from './invite-manager';
export { IpRateLimiter } from './ip-rate-limiter';

// ─── Types ──────────────────────────────────────────────────────────

interface Env {
  RATE_LIMITER: DurableObjectNamespace;
  INVITE_MANAGER: DurableObjectNamespace;
  IP_RATE_LIMITER: DurableObjectNamespace;
  ALLOWLIST: KVNamespace;
  ALLOWED_ORIGINS: string;
  /** Comma-separated bare https origins for TX-status probes (D8/PR-3a).
   *  MUST equal the client's VITE_STATUS_GATEWAYS: the dead formula is one
   *  formula for both halves, so a divergence would let one of them reach a
   *  verdict the other cannot. The deploy gate compares the normalized lists.
   *  Empty/unset falls back to a lone arweave.net, where `dead` is unreachable
   *  by construction. */
  STATUS_GATEWAYS?: string;
  /** Bare https origins for D9 publication authentication, comma separated,
   *  and the ORDER IS NORMATIVE — the pool is tried in sequence. Separate from
   *  STATUS_GATEWAYS because the two answer different questions: status needs
   *  only an HTTP code (so a slow-but-correct origin is fine), while this pool
   *  serves `/tx/<id>` and `/raw/<id>` on the path that decides whether a txId
   *  may be bound to a payload. MUST equal the client's VITE_PAYLOAD_GATEWAYS;
   *  the deploy gate compares them in order. Empty/unset falls back to a lone
   *  arweave.net, which still verifies — D9 is cryptographic, so a single
   *  origin costs redundancy, never correctness. */
  PAYLOAD_GATEWAYS?: string;
  /** Full 40-char commit SHA this build was deployed from, injected by the
   *  trusted deploy workflow from its verified `candidate` input — NEVER from
   *  `github.sha`, which is the SHA of the workflow's own trusted head. */
  RELEASE_SHA?: string;
  /** Cloudflare version_metadata binding: the Worker's own ACTIVE version id.
   *  Self-reported SHA cannot distinguish a re-deploy of the same commit; this
   *  can. Optional so tests and older configs keep working. */
  CF_VERSION_METADATA?: { id?: string; tag?: string; timestamp?: string };
  /** EVERY Arweave wallet address this project has ever posted under, comma
   *  separated (D2/D9). The worker authenticates a publication before binding
   *  its `txId` to a payload fingerprint, and `address ∈ TRUSTED_OWNERS` is one
   *  of the D9 steps.
   *
   *  Deliberately NOT derived from `ARWEAVE_JWK`: that is the CURRENT wallet,
   *  and after a rotation it cannot confirm the project's OWN older
   *  transactions — every one of them would stop authenticating and healthy
   *  records would start answering conflicts. This is a HISTORICAL list, and
   *  entries are never removed.
   *
   *  Optional in the TYPE, mandatory in FACT: missing, empty or malformed
   *  answers 503 on /upload rather than skipping the check. What it must
   *  contain is pinned in scripts/owner-pins.mjs and gated on deploy by
   *  scripts/check-trusted-owners.mjs. */
  TRUSTED_OWNERS?: string;
  MAX_BODY_BYTES: string;
  RATE_LIMIT_PER_HOUR: string;
  ARWEAVE_JWK: string;
  ADMIN_SECRET: string;
  /** Dedicated stable secret (≥16 chars; e.g. `openssl rand -base64 32`) for
   *  recovery-token HMACs. MANDATORY: /upload 503s while it is unset — posting
   *  without it would make a triple-failure unrecoverable (duplicate paid TX).
   *  Deliberately NOT derived from ARWEAVE_JWK: wallet rotation must not
   *  invalidate outstanding tokens (they'd fail closed, blocking recovery). */
  RECOVERY_HMAC_SECRET: string;
  /** GLOBAL upload kill switch — the incident lever (§1.9). Strictly "true"
   *  enables; ANY other value (missing, garbage) fails CLOSED: EVERY /upload
   *  (v1–v4, including rechecks and recovery reconciliation) gets
   *  503 {code:'uploads_disabled'} right after the IP limiter, before the body
   *  is even read. Unlike V3/V4 switches this stops the WHOLE flow: those gate
   *  only their declared version, while v1/v2 traffic (legacy re-sends included)
   *  would still reach the paid POST path. An emergency lever must be named
   *  what it is — not be a side effect of the rate-limit parser rejecting "0".
   *  Source of truth: wrangler.toml (dashboard overrides are emergency-only
   *  and must be synced back to the repo immediately). */
  UPLOADS_ENABLED?: string;
  /** Upload kill switch for App-Version=3 (versioned notes). Strictly "true"
   *  enables; ANY other value (missing, garbage) fails CLOSED — v3 uploads get
   *  503 {code:'v3_uploads_disabled'} after the IP limiter but BEFORE any
   *  per-owner RateLimiter DO call or Arweave POST. v1/v2 are unaffected.
   *  Source of truth: wrangler.toml (dashboard overrides are emergency-only
   *  and must be synced back to the repo immediately). */
  V3_UPLOADS_ENABLED?: string;
  /** Upload kill switch for App-Version=4 (safebox entries). EXACT copy of the
   *  v3 contract: strictly "true" enables; ANY other value (missing, garbage)
   *  fails CLOSED — v4 uploads get 503 {code:'v4_uploads_disabled'} after the
   *  IP limiter but BEFORE any per-owner RateLimiter DO call or Arweave POST.
   *  v1/v2/v3 are unaffected. Source of truth: wrangler.toml. */
  V4_UPLOADS_ENABLED?: string;
  /** Analytics Engine dataset (PR-2 metrics). ALL metrics values are OPTIONAL
   *  by contract: the runtime deliberately survives a missing binding/vars —
   *  telemetry is fail-closed, the request path is fail-open (see makeEmit). */
  METRICS?: AnalyticsEngineDataset;
  /** Metrics master switch. STRICTLY "true" enables writes; any other value
   *  (missing, garbage) disables them without touching requests. */
  METRICS_ENABLED?: string;
  /** AE dataset name for /admin/metrics SQL. Validated as ^[a-z0-9_]{1,64}$
   *  before it is EVER substituted into a SQL template; invalid/missing → 503. */
  METRICS_DATASET?: string;
  /** Cloudflare account id for the AE SQL API (a var and an identifier, not a
   *  secret — same value as the Actions CLOUDFLARE_ACCOUNT_ID variable). Empty
   *  until the operator fills it; /admin/metrics answers 503 meanwhile. */
  CF_ACCOUNT_ID?: string;
  /** AE SQL API token (secret). Scope: Account → Account Analytics → Read for
   *  this ONE account and nothing else — the scope cannot be narrowed to a
   *  single dataset, so it honestly reads analytics of the whole account
   *  (docs/SECRETS.md). /admin/metrics answers 503 while it is missing. */
  CF_ANALYTICS_TOKEN?: string;
  /** Dedicated bearer for POST /admin/metrics (least privilege: the metrics
   *  reader gets NO seed-invite/revoke rights and vice versa). 503 while
   *  missing. Compared with the same constant-time helper as ADMIN_SECRET. */
  METRICS_ADMIN_SECRET?: string;
}

// ─── Per-IP baseline rate limit (D-baseline) ────────────────────────
// Primary anti-abuse on Cloudflare Free (no WAF rate-limiting).
const IP_RATE_LIMIT = 60;              // requests per window per IP
const IP_RATE_WINDOW_MS = 60_000;      // 1 minute

// A committed TX must be at least this old before a recheck may re-post it
// (guards against re-posting a TX that just hasn't propagated yet).
const MIN_COMMITTED_AGE_MS = 30 * 60_000; // 30 min

// Body cap for the auth endpoints (/check-registration, /register). They carry
// a tiny JSON envelope; MAX_BODY_BYTES only ever guarded /upload, so an
// unauthenticated caller could stream megabytes into memory before the
// signature was even checked.
const AUTH_BODY_MAX_BYTES = 4096;
/** Longest invite code we will even look at (DO lookup key). */
const MAX_INVITE_CODE_LENGTH = 128;

// ─── Entry ──────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin') || '';
    const allowedOrigins = env.ALLOWED_ORIGINS.split(',');

    // All responses go through addCors() — handlers don't know about CORS
    const response = request.method === 'OPTIONS'
      ? handleOptions(origin, allowedOrigins)
      : addCors(await handleRequest(request, env), origin, allowedOrigins);

    // Cache-Control: no-store on EVERY /admin/metrics response — centrally,
    // not in the handler (M r19): the router's Content-Type check answers 415
    // BEFORE dispatch, and a wrong method falls through to 404, so the header
    // must be attached here to cover 415/404/401/4xx/5xx alike.
    if (new URL(request.url).pathname === '/admin/metrics') {
      const headers = new Headers(response.headers);
      headers.set('Cache-Control', 'no-store');
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    return response;
  },
};

// ─── Router ─────────────────────────────────────────────────────────

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  // Capability surface: lets clients (and the operator runbook) verify what the
  // deployed worker accepts WITHOUT a paid probe. `versions` = accepted
  // App-Versions; `v3Uploads`/`v4Uploads` mirror the kill switches, `uploads`
  // mirrors the GLOBAL incident lever (false = every version paused). Clients
  // resume a paused version only on ok===true AND that version's flag===true
  // AND versions includes it (the list describes the ACCEPTOR and still
  // contains the version while its gate is off).
  if (url.pathname === '/health') {
    // ── Freshness proof ──
    // `no-store` keeps an intermediary from serving a stale answer, but it
    // cannot tell us whether the answer WE hold is stale. So a trusted probe
    // sends a nonce and requires it back verbatim; a browser or an operator
    // with curl sends none and gets the same diagnostic body as always.
    const nonce = url.searchParams.get('nonce');
    if (nonce !== null && !/^[0-9a-f]{16}$/.test(nonce)) {
      return error('nonce must be 16 lowercase hex characters', 400);
    }
    const origins = statusOrigins(env);
    return healthJson({
      ok: true,
      versions: ['1', '2', '3', '4'],
      uploads: uploadsEnabled(env),
      v3Uploads: v3UploadsEnabled(env),
      v4Uploads: v4UploadsEnabled(env),
      // The quorum SEMANTICS this build implements, taken from the module that
      // implements them. Deliberately NOT a var: if it came from configuration,
      // a build carrying the old single-gateway logic could be relabelled as
      // the safe one and have its uploads switched back on.
      // The MACHINE-READABLE capability a client with import depends on (D2a):
      // this build compares a publication fingerprint before handing back a
      // historical txId. Deliberately a constant, never a var — if it came from
      // configuration, a build carrying the old logic could be relabelled as the
      // safe one. The client refuses to store a txId from a response without it.
      semanticIdempotency: 1,
      statusQuorumPolicy: QUORUM_POLICY_ID,
      statusGatewaysCount: origins.length,
      statusGatewaysHash: await statusGatewaysHash(origins),
      // Identity of what is ACTUALLY running: the SHA the trusted workflow
      // deployed, and the version id Cloudflare activated. The SHA alone cannot
      // distinguish a re-deploy of the same commit — the version id can.
      releaseSha: env.RELEASE_SHA ?? null,
      workerVersionId: env.CF_VERSION_METADATA?.id ?? null,
      ...(nonce !== null ? { nonce } : {}),
    });
  }

  // Diagnostics only: lets an operator discover the proxy wallet address to pin
  // in the client's VITE_TRUSTED_OWNERS. NEVER used as the client's root of trust.
  if (url.pathname === '/wallet-address' && request.method === 'GET') {
    return handleWalletAddress(request, env);
  }

  // All POST endpoints require JSON
  if (request.method === 'POST') {
    const ct = request.headers.get('Content-Type') || '';
    if (!ct.includes('application/json')) {
      return error('Content-Type must be application/json', 415);
    }
  }

  if (url.pathname === '/check-registration' && request.method === 'POST') {
    return handleCheckRegistration(request, env);
  }
  if (url.pathname === '/register' && request.method === 'POST') {
    return handleRegister(request, env);
  }
  if (url.pathname === '/upload' && request.method === 'POST') {
    return handleUpload(request, env);
  }
  if (url.pathname === '/admin/seed-invite' && request.method === 'POST') {
    return handleAdminSeedInvite(request, env);
  }
  if (url.pathname === '/admin/revoke' && request.method === 'POST') {
    return handleAdminRevoke(request, env);
  }
  if (url.pathname === '/admin/metrics' && request.method === 'POST') {
    return handleAdminMetrics(request, env);
  }

  return new Response('Not found', { status: 404 });
}

// ─── /wallet-address (diagnostics) ──────────────────────────────────

// Isolate-level cache: the address is constant per deployment, so derive it once
// instead of parsing the full JWK on every request.
//
// KEYED ON THE JWK, not merely «computed once». The address used to feed a
// diagnostic endpoint, where a stale value was only confusing; it now decides
// whether /upload is allowed to sign at all (D2/D9), and a cache that ignores
// which key it derived from would answer for the PREVIOUS wallet — passing the
// trust check for a key that was never checked.
let walletAddressCache: { jwk: string; address: Promise<string> } | null = null;

function getWalletAddress(env: Env): Promise<string> {
  const jwk = env.ARWEAVE_JWK;
  if (walletAddressCache?.jwk !== jwk) {
    walletAddressCache = {
      jwk,
      address: (async () => {
        const wallet = JSON.parse(jwk);
        const arweave = Arweave.init({ host: 'arweave.net', port: 443, protocol: 'https' });
        return arweave.wallets.jwkToAddress(wallet);
      })(),
    };
  }
  return walletAddressCache.address;
}

/**
 * The historical trusted-owner set, or `null` when it is unusable.
 *
 * Fail-closed by construction: missing, empty and malformed all collapse to
 * `null`, and every caller turns `null` into a 503. Treating an absent list as
 * «no constraint» would silently weaken D9 to «some well-formed transaction
 * exists», which an attacker satisfies by posting their own.
 *
 * NOT cached at isolate level: the value is a plain string on `env`, so
 * re-parsing it costs a split of a short list, and a cache would be one more
 * thing to invalidate on a config change.
 */
export function resolveTrustedOwners(env: Env): string[] | null {
  const raw = env.TRUSTED_OWNERS;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const owners = parseTrustedOwners(raw);
    return owners.length > 0 ? owners : null;
  } catch {
    // A malformed entry is a CONFIGURATION defect, and dropping it silently
    // would leave a set that looks fine and is quietly narrower.
    return null;
  }
}

/**
 * Refuse uploads while the server's own wallet is outside the trusted set.
 *
 * The asymmetry is the point of the rotation runbook: a publication this
 * worker makes RIGHT NOW is signed by `ARWEAVE_JWK`, so if that address is not
 * trusted, the worker is about to create transactions that neither half will
 * ever be able to authenticate. Posting them is worse than refusing — the
 * money is spent and the record is unverifiable forever.
 *
 * Hence the order in the runbook: add the new address to both sets, deploy,
 * and only THEN switch the key.
 */
export async function walletTrust(
  env: Env,
  owners: string[],
): Promise<'trusted' | 'untrusted' | 'undeterminable'> {
  let address: string;
  try {
    address = await getWalletAddress(env);
  } catch {
    walletAddressCache = null; // never cache a failure
    // A JWK whose address cannot be derived is a JWK that cannot SIGN either,
    // so it creates no untrusted transaction and this guard has nothing to
    // protect against. Deliberately NOT refused here: the malformed-JWK paths
    // have their own typed outcome further down (502 / `arweave_throw`, §R4),
    // and answering «misconfigured» here would relabel them from one true
    // statement into a less precise one.
    return 'undeterminable';
  }
  return owners.includes(address) ? 'trusted' : 'untrusted';
}

async function handleWalletAddress(request: Request, env: Env): Promise<Response> {
  // Rate-limit even this diagnostic endpoint (it is public and otherwise
  // unauthenticated) — but on its OWN bucket, so hammering it cannot starve
  // the main upload/register budget of the same IP.
  const ipBlock = await enforceIpLimit(request, env, 'diag');
  if (ipBlock) return ipBlock;

  try {
    return json({ address: await getWalletAddress(env) });
  } catch {
    walletAddressCache = null; // never cache a failure
    return error('Wallet not configured', 503);
  }
}

// ─── Admin auth (L12) ───────────────────────────────────────────────

/**
 * Constant-time bearer auth: SHA-256 both sides to a fixed 32 bytes, then
 * timingSafeEqual — no early exit on length mismatch and no crash on it
 * (timingSafeEqual itself throws on unequal input lengths; digests never are).
 * Generalised over WHICH secret (PR-2): /admin/metrics authenticates against
 * its own METRICS_ADMIN_SECRET without duplicating the cryptography.
 */
async function verifyBearerSecret(expectedSecret: string | undefined, authHeader: string | null): Promise<boolean> {
  if (!expectedSecret || !authHeader) return false;
  const enc = new TextEncoder();
  const [given, expected] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(authHeader)),
    crypto.subtle.digest('SHA-256', enc.encode(`Bearer ${expectedSecret}`)),
  ]);
  return crypto.subtle.timingSafeEqual(new Uint8Array(given), new Uint8Array(expected));
}

async function verifyAdminSecret(env: Env, authHeader: string | null): Promise<boolean> {
  return verifyBearerSecret(env.ADMIN_SECRET, authHeader);
}

// ─── /admin/seed-invite ─────────────────────────────────────────────

async function handleAdminSeedInvite(request: Request, env: Env): Promise<Response> {
  if (!env.ADMIN_SECRET) return error('Admin endpoint not configured', 503);
  if (!(await verifyAdminSecret(env, request.headers.get('Authorization')))) {
    return error('Unauthorized', 401);
  }

  let codes: string[];
  try {
    const body: { codes: string[] } = await request.json();
    codes = body.codes;
  } catch {
    return error('Invalid JSON', 400);
  }
  if (!Array.isArray(codes) || codes.length === 0) return error('codes[] required', 400);

  const inviteMgr = env.INVITE_MANAGER.get(env.INVITE_MANAGER.idFromName('global'));
  const resp = await inviteMgr.fetch(new Request('http://internal/seed-invite', {
    method: 'POST',
    body: JSON.stringify({ codes }),
  }));
  // Propagate the DO's status: it enforces the batch/shape caps and returns 400
  // on a bad request, which must not surface to the operator as a 200.
  if (!resp.ok) {
    const body: { error?: string } = await resp.json();
    return error(body.error || 'seed-invite failed', resp.status);
  }
  return json(await resp.json());
}

// ─── /admin/revoke (M11) ────────────────────────────────────────────

/**
 * Revoke a registered key. The Worker only validates and forwards: the SINGLE
 * `denied` KV write happens inside the DO's serialized critical section,
 * BEFORE its storage mutations (deny-first, fail-closed). No worker-side
 * pre-deny: KV allows roughly one write per second per key, so a second write
 * to the same key could be rate-limited — making the DO's (authoritative)
 * write the one that fails, and the revoke stably unable to complete.
 * If the DO's KV write fails: DO state unchanged → retryable 503.
 */
async function handleAdminRevoke(request: Request, env: Env): Promise<Response> {
  if (!env.ADMIN_SECRET) return error('Admin endpoint not configured', 503);
  if (!(await verifyAdminSecret(env, request.headers.get('Authorization')))) {
    return error('Unauthorized', 401);
  }

  let publicKey: unknown;
  try {
    ({ publicKey } = await request.json<{ publicKey?: unknown }>());
  } catch {
    return error('Invalid JSON', 400);
  }
  // Shape guard only. The CANONICAL requirement is enforced by the DO, which
  // can additionally honour an EXACT match on a legacy entry admitted before
  // the canonical gate existed — rejecting non-canonical keys here would leave
  // those unreachable through the admin API (operators would need direct DO
  // access). A typo'd value still gets a 400 from the DO because no such entry
  // exists, so it can never masquerade as a successful revoke.
  if (typeof publicKey !== 'string' || publicKey.length === 0 || publicKey.length > 64) {
    return error('publicKey required', 400);
  }

  let resp: Response;
  try {
    const inviteMgr = env.INVITE_MANAGER.get(env.INVITE_MANAGER.idFromName('global'));
    resp = await inviteMgr.fetch(new Request('http://internal/revoke', {
      method: 'POST',
      body: JSON.stringify({ publicKey }),
    }));
  } catch (e) {
    console.error('REVOKE_DO_FAILED', e);
    return error('Revoke failed — retry', 503);
  }
  if (!resp.ok) {
    const body: { error?: string } = await resp.json();
    return error(body.error || 'Revoke failed', resp.status);
  }
  return json(await resp.json());
}

// ─── /admin/metrics (PR-2) ──────────────────────────────────────────

// Server-to-server / operator-only by declaration: CORS deliberately does NOT
// allow the Authorization header (corsHeaders below), so the long-lived
// METRICS_ADMIN_SECRET can never end up in a browser dashboard — a future UI
// gets its own backend or Cloudflare Access. Response order: missing OWN
// secret → 503, bad bearer → 401, missing upstream config → 503 (config is
// checked only AFTER authentication). Cache-Control: no-store is attached
// centrally in fetch() for EVERY response on this path, including 415/404.
const METRICS_UPSTREAM_TIMEOUT_MS = 10_000;
const METRICS_UPSTREAM_BODY_CAP_BYTES = 256 * 1024; // 256 KiB
const METRICS_REQUEST_BODY_CAP_BYTES = 1024; // authenticated ≠ exempt from body caps

async function handleAdminMetrics(request: Request, env: Env): Promise<Response> {
  if (!env.METRICS_ADMIN_SECRET) return error('Metrics endpoint not configured', 503);
  if (!(await verifyBearerSecret(env.METRICS_ADMIN_SECRET, request.headers.get('Authorization')))) {
    return error('Unauthorized', 401);
  }
  // Upstream config — after auth. The dataset name is validated BEFORE it may
  // ever be substituted into a SQL template (unchecked concatenation is
  // forbidden — see buildMetricsReportSql).
  if (!env.CF_ACCOUNT_ID || !env.CF_ANALYTICS_TOKEN) {
    return error('Metrics upstream not configured', 503);
  }
  if (typeof env.METRICS_DATASET !== 'string' || !METRICS_DATASET_RE.test(env.METRICS_DATASET)) {
    return error('Metrics upstream not configured', 503);
  }

  const body = await readLimitedBody(request, METRICS_REQUEST_BODY_CAP_BYTES);
  if ('tooLarge' in body) return body.tooLarge;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    return error('Invalid JSON', 400);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return error('Invalid body: must be a JSON object', 400);
  }
  const { report, hours } = parsed as { report?: unknown; hours?: unknown };
  if (typeof report !== 'string' || !(METRICS_REPORTS as readonly string[]).includes(report)) {
    return error('Unknown report', 400);
  }
  const effectiveHours = hours === undefined ? 24 : hours;
  if (typeof effectiveHours !== 'number' || !Number.isInteger(effectiveHours)
      || effectiveHours < 1 || effectiveHours > 168) {
    return error('hours must be an integer in 1..168', 400);
  }

  const sql = buildMetricsReportSql(report as MetricsReport, env.METRICS_DATASET, effectiveHours);
  let upstream: Response;
  try {
    upstream = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}` },
        body: sql,
        signal: AbortSignal.timeout(METRICS_UPSTREAM_TIMEOUT_MS),
      },
    );
  } catch {
    return error('Metrics upstream unavailable', 503); // timeout / network
  }
  // Upstream body is NEVER proxied to the client — only the class and our own
  // strings. Non-2xx → 502; oversized/malformed 2xx → 502.
  if (!upstream.ok) return error('Metrics upstream error', 502);
  let text: string | null;
  try {
    text = await readCappedText(upstream, METRICS_UPSTREAM_BODY_CAP_BYTES);
  } catch {
    return error('Metrics upstream unavailable', 503); // aborted mid-body = timeout
  }
  if (text === null) return error('Metrics upstream error', 502); // over the cap
  // Every template ends in FORMAT JSON; the standard upstream document is
  // {meta, data, rows} (L r17). ONE response shape — ours: {rows: data}.
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return error('Metrics upstream error', 502);
  }
  const data = (typeof doc === 'object' && doc !== null) ? (doc as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) return error('Metrics upstream error', 502);
  return json({ rows: data });
}

// ─── /check-registration ────────────────────────────────────────────

async function handleCheckRegistration(request: Request, env: Env): Promise<Response> {
  const ipBlock = await enforceIpLimit(request, env);
  if (ipBlock) return ipBlock;

  const body = await readLimitedBody(request, AUTH_BODY_MAX_BYTES);
  if ('tooLarge' in body) return body.tooLarge;
  const bodyText = body.text;
  const publicKeyB64 = request.headers.get('X-Public-Key');
  const signatureB64 = request.headers.get('X-Signature');
  if (!publicKeyB64 || !signatureB64) return error('Missing auth headers', 401);
  // CANONICAL form only (see handleRegister): the allowlist is keyed by this
  // exact string, so alternative encodings of the same key must never be
  // addressable — otherwise a key could be registered under a spelling that
  // /admin/revoke (canonical-only) can never reach.
  if (!isValidPublicKeyB64(publicKeyB64)) {
    return error('publicKey must be canonical base64 of a 32-byte key', 400);
  }

  // 1. Parse body and validate consistency
  let bodyPK: string, timestamp: number;
  try {
    const parsed = JSON.parse(bodyText);
    bodyPK = parsed.publicKey;
    timestamp = parsed.timestamp;
  } catch {
    return error('Invalid JSON', 400);
  }
  if (bodyPK !== publicKeyB64) return error('publicKey mismatch (body vs header)', 400);
  if (!isFreshTimestamp(timestamp)) return error('Timestamp expired or device clock skew (allowed drift: 5 min) — check the device date/time', 401);

  // 2. Verify Ed25519 signature — BEFORE any lookup
  const verifyResult = await verifySignature(publicKeyB64, signatureB64, bodyText);
  if (verifyResult) return verifyResult;

  // 3. Check KV cache (typed model, D3), then DO fallback on miss
  const cached = await readAllowCache(env.ALLOWLIST, publicKeyB64);
  let allowed: boolean;
  if (cached === 'allowed') {
    allowed = true;
  } else if (cached === 'denied') {
    allowed = false;
  } else {
    // miss (absent / legacy 'true' / invalid) → serialized re-derive + cache
    // write INSIDE the DO (single cache owner). The verdict is FINAL: if a
    // revoke won the race, this returns allowed:false — never resurrect it.
    const inviteMgr = env.INVITE_MANAGER.get(env.INVITE_MANAGER.idFromName('global'));
    const checkResp = await inviteMgr.fetch(new Request('http://internal/refresh-allowed', {
      method: 'POST',
      body: JSON.stringify({ publicKey: publicKeyB64 }),
    }));
    const checkResult: { allowed: boolean } = await checkResp.json();
    allowed = checkResult.allowed;
  }

  return json({ allowed });
}

// ─── /register ──────────────────────────────────────────────────────

async function handleRegister(request: Request, env: Env): Promise<Response> {
  const ipBlock = await enforceIpLimit(request, env);
  if (ipBlock) return ipBlock;

  const body = await readLimitedBody(request, AUTH_BODY_MAX_BYTES);
  if ('tooLarge' in body) return body.tooLarge;
  const bodyText = body.text;
  const publicKeyB64 = request.headers.get('X-Public-Key');
  const signatureB64 = request.headers.get('X-Signature');
  if (!publicKeyB64 || !signatureB64) return error('Missing auth headers', 401);

  // 1. Validate publicKey format — CANONICAL base64 of 32 bytes only.
  //    A non-canonical spelling (e.g. the unpadded 43-char form) decodes to the
  //    same key and would pass signature verification, but it would be stored
  //    under a DIFFERENT `pk:` entry than the canonical one — leaving a
  //    registered key that /admin/revoke can never address. Reject up front.
  if (!isValidPublicKeyB64(publicKeyB64)) {
    return error('publicKey must be canonical base64 of a 32-byte key', 400);
  }

  // 2. Verify Ed25519 signature
  const verifyResult = await verifySignature(publicKeyB64, signatureB64, bodyText);
  if (verifyResult) return verifyResult;

  // 3. Parse body (after signature verified)
  let inviteCode: string, bodyPK: string, regTimestamp: number;
  try {
    const parsed = JSON.parse(bodyText);
    inviteCode = parsed.inviteCode;
    bodyPK = parsed.publicKey;
    regTimestamp = parsed.timestamp;
  } catch {
    return error('Invalid JSON', 400);
  }
  if (!inviteCode || !bodyPK) return error('Missing inviteCode or publicKey', 400);
  if (typeof inviteCode !== 'string' || inviteCode.length > MAX_INVITE_CODE_LENGTH) {
    return error('Invalid inviteCode', 400);
  }
  if (bodyPK !== publicKeyB64) return error('publicKey mismatch', 400);
  if (!isFreshTimestamp(regTimestamp)) return error('Timestamp expired or device clock skew (allowed drift: 5 min) — check the device date/time', 401);

  // 4. Delegate to InviteManager DO — ATOMIC check + use
  const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
  const inviteMgr = env.INVITE_MANAGER.get(env.INVITE_MANAGER.idFromName('global'));
  const doResp = await inviteMgr.fetch(new Request('http://internal/register', {
    method: 'POST',
    body: JSON.stringify({ inviteCode, publicKey: publicKeyB64, clientIP }),
  }));

  if (!doResp.ok) {
    const body: { error?: string } = await doResp.json();
    return error(body.error || 'Registration failed', doResp.status);
  }
  // 5. The cache write happens INSIDE the DO's serialized register section
  // (fresh registrations only — alreadyRegistered writes nothing, so garbage-
  // invite spam can never resurrect a racing revoke's `denied`). Nothing to
  // write here: the worker must not own unserialized positive cache writes.
  await doResp.json(); // drain

  return json({ ok: true });
}

// ─── /upload ────────────────────────────────────────────────────────

async function handleUpload(request: Request, env: Env): Promise<Response> {
  const ipBlock = await enforceIpLimit(request, env);
  if (ipBlock) return ipBlock;

  // 0a. GLOBAL kill switch — the incident lever, checked before ANYTHING else
  // (even body read): during e.g. a RECOVERY_HMAC_SECRET compromise the whole
  // v1–v4 flow must stop, and the stop must not depend on the validity of any
  // other config value. Deliberately 503, never 403 (the client reads 403 as
  // "not registered" and drops its registration marker).
  if (!uploadsEnabled(env)) {
    return new Response(JSON.stringify({ code: 'uploads_disabled' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 0. Strict config — fail CLOSED (503) rather than disabling a limit on NaN.
  const maxBytes = parsePositiveInt(env.MAX_BODY_BYTES);
  const quotaLimit = parsePositiveInt(env.RATE_LIMIT_PER_HOUR);
  if (maxBytes === null || quotaLimit === null) return error('Server misconfigured', 503);
  // RECOVERY_HMAC_SECRET is MANDATORY for uploads: without it a triple-failure
  // (POST ok, mark-posted + commit both lost) leaves the client with no provable
  // recovery hint, and once the reservation TTL lapses the recheck degrades into
  // a duplicate paid POST. Refuse to post at all rather than post unrecoverably.
  if (typeof env.RECOVERY_HMAC_SECRET !== 'string' || env.RECOVERY_HMAC_SECRET.length < 16) {
    return error('Server misconfigured', 503);
  }
  // TRUSTED_OWNERS is MANDATORY for uploads (D2/D9): it is what a publication
  // is authenticated against before the worker binds an existing txId to a
  // payload fingerprint. An absent list is not «no constraint» — it is a
  // missing root of trust, so it fails closed here rather than being skipped
  // at the point of use.
  const trustedOwners = resolveTrustedOwners(env);
  if (trustedOwners === null) return error('Server misconfigured', 503);
  // …and the wallet about to SIGN must itself be trusted, or this request
  // would create a transaction nobody can ever authenticate. Only a DERIVABLE
  // address that is absent from the set refuses here — see walletTrust.
  if ((await walletTrust(env, trustedOwners)) === 'untrusted') {
    return error('Server misconfigured', 503);
  }

  // Metrics emitter (PR-2). Telemetry is fail-closed / request path fail-open:
  // a noop unless METRICS_ENABLED === 'true' AND the binding exists.
  const emit = makeEmit(env);

  // 1. Read body under the configured cap (Content-Length pre-check included)
  const body = await readLimitedBody(request, maxBytes);
  if ('tooLarge' in body) return body.tooLarge;
  const bodyText = body.text;

  // 2. Parse headers + body
  const publicKeyB64 = request.headers.get('X-Public-Key');
  const signatureB64 = request.headers.get('X-Signature');
  if (!publicKeyB64 || !signatureB64) return error('Missing auth headers', 401);
  // Canonical spelling only — the allowlist/quota keys are derived from this
  // exact string (see handleRegister).
  if (!isValidPublicKeyB64(publicKeyB64)) {
    return error('publicKey must be canonical base64 of a 32-byte key', 400);
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(bodyText);
  } catch {
    return error('Invalid JSON', 400);
  }
  if (typeof parsedBody !== 'object' || parsedBody === null || Array.isArray(parsedBody)) {
    return error('Invalid body: must be a JSON object', 400);
  }
  const { data, tags, ownerHash, timestamp, recheck, recovery } = parsedBody as {
    data?: unknown; tags?: unknown; ownerHash?: unknown; timestamp?: unknown; recheck?: unknown; recovery?: unknown;
  };
  if (typeof data !== 'string' || typeof ownerHash !== 'string' || !Array.isArray(tags)) {
    return error('Missing/invalid required fields', 400);
  }
  const wantsRecheck = recheck === true;
  // Optional server-signed recovery hint (validated by HMAC below, never trusted raw).
  const hasRecoveryField = recovery !== undefined && recovery !== null;
  const recoveryHint = (recovery && typeof recovery === 'object'
    && typeof (recovery as { txId?: unknown }).txId === 'string'
    && typeof (recovery as { postedAt?: unknown }).postedAt === 'number'
    && typeof (recovery as { token?: unknown }).token === 'string')
    ? (recovery as { txId: string; postedAt: number; token: string })
    : undefined;
  // FAIL CLOSED on a present-but-unusable recovery hint. A malformed hint (or
  // one sent outside a recheck) must never silently degrade into a fresh paid
  // post — the referenced TX may be alive on-chain (duplicate + quota burn).
  if (hasRecoveryField && (!recoveryHint || !wantsRecheck)) {
    // Structured {code} + human text, HTTP 400 preserved. Same pattern as
    // v3_uploads_disabled: an old client sees a plain error, a new one can
    // react to the code (terminal quarantine instead of endless recheck).
    // The shared error() helper stays plain-text — changing it would change
    // the shape of EVERY API error.
    return recoveryInvalid();
  }

  // 3. Validate timestamp (5 min window) — reject NaN/non-number (anti-replay)
  if (!isFreshTimestamp(timestamp)) return error('Timestamp expired or device clock skew (allowed drift: 5 min) — check the device date/time', 401);

  // 4. Verify Ed25519 signature FIRST — before any KV/DO lookups
  const verifyResult = await verifySignature(publicKeyB64, signatureB64, bodyText);
  if (verifyResult) return verifyResult;

  // 5. Verify ownerHash = SHA-256(publicKey) (R5)
  const publicKey = base64ToBytes(publicKeyB64);
  const expectedOwnerHash = bytesToBase64(
    new Uint8Array(await crypto.subtle.digest('SHA-256', publicKey))
  );
  if (ownerHash !== expectedOwnerHash) return error('ownerHash/publicKey mismatch', 400);

  // 6. Validate publicKey in allowlist (anti-sybil, R6) — typed model (D3).
  // On a miss, /refresh-allowed re-derives AND caches inside the DO's critical
  // section; its verdict is FINAL (a mid-flight revoke yields allowed:false).
  const cachedAccess = await readAllowCache(env.ALLOWLIST, publicKeyB64);
  if (cachedAccess === 'denied') return error('Not registered', 403);
  if (cachedAccess === 'miss') {
    const inviteMgr = env.INVITE_MANAGER.get(env.INVITE_MANAGER.idFromName('global'));
    const checkResp = await inviteMgr.fetch(new Request('http://internal/refresh-allowed', {
      method: 'POST',
      body: JSON.stringify({ publicKey: publicKeyB64 }),
    }));
    const checkResult: { allowed: boolean } = await checkResp.json();
    if (!checkResult.allowed) return error('Not registered', 403);
  }

  // 7. Validate tags — STRICT, version-specific (reader-before-writer: accept all).
  //    v1: 6 tags incl. Timestamp; outer data {id,c,iv,t}.
  //    v2: 5 tags, NO Timestamp (date lives inside the encrypted envelope);
  //        outer data {id,c,iv} — no t on-chain.
  //    v3: identical wire shape to v2 (5 tags, {id,c,iv}); the version-chain
  //        metadata lives INSIDE the encrypted envelope. Distinguished on-chain
  //        only by the App-Version tag and the UUIDv8 Note-Id namespace.
  //    v4: safebox entry — same 5 tags, but a SPLIT-ENVELOPE data object
  //        {id,mc,miv,sc,siv}: two independently-keyed ciphertexts (meta +
  //        secret) in one record. UUIDv8 ids like v3.
  const declaredVersion = Array.isArray(tags)
    ? tags.find(t => t && t.name === 'App-Version')?.value
    : undefined;
  if (declaredVersion !== '1' && declaredVersion !== '2' &&
      declaredVersion !== '3' && declaredVersion !== '4') {
    return error('Unsupported App-Version', 400);
  }
  const hasTimestamp = declaredVersion === '1';
  const isSplitEnvelope = declaredVersion === '4';

  const REQUIRED_TAGS = new Map<string, string>([
    ['App-Name', 'EternalNotes'],
    ['App-Version', declaredVersion],
    ['Content-Type', 'application/json'],
  ]);
  const REQUIRED_DYNAMIC = hasTimestamp
    ? new Set(['Owner-Hash', 'Timestamp', 'Note-Id'])
    : new Set(['Owner-Hash', 'Note-Id']);
  const ALL_EXPECTED = new Set([...REQUIRED_TAGS.keys(), ...REQUIRED_DYNAMIC]);

  if (!Array.isArray(tags)) return error('tags must be an array', 400);
  if (tags.length !== ALL_EXPECTED.size) return error(`Expected exactly ${ALL_EXPECTED.size} tags`, 400);

  const tagMap = new Map<string, string>();
  for (const tag of tags) {
    if (typeof tag !== 'object' || tag === null ||
        typeof tag.name !== 'string' || typeof tag.value !== 'string') {
      return error('Invalid tag structure', 400);
    }
    // Timestamp is not in ALL_EXPECTED for v2, so a v2 upload carrying it is rejected here.
    if (!ALL_EXPECTED.has(tag.name)) return error(`Forbidden tag: ${tag.name}`, 400);
    if (tagMap.has(tag.name)) return error(`Duplicate tag: ${tag.name}`, 400);
    tagMap.set(tag.name, tag.value);
  }

  // Validate fixed-value tags
  for (const [name, expected] of REQUIRED_TAGS) {
    if (tagMap.get(name) !== expected) return error(`Invalid ${name}: expected "${expected}"`, 400);
  }

  // 8. Parse data — must be a plain object (not null/array/primitive)
  let parsedData: {
    id?: unknown; c?: unknown; iv?: unknown; t?: unknown;
    mc?: unknown; miv?: unknown; sc?: unknown; siv?: unknown;
  };
  try {
    parsedData = JSON.parse(data);
  } catch {
    return error('Invalid data JSON', 400);
  }
  if (typeof parsedData !== 'object' || parsedData === null || Array.isArray(parsedData)) {
    return error('Invalid data: must be a JSON object', 400);
  }

  // 9. STRICT data schema — EXACT key set per version (no extra fields, so a
  //    v2/v3 payload cannot smuggle a Timestamp/`t` and leak the date on-chain,
  //    and a v4 record can never carry a single-envelope `c`/`iv` pair).
  const allowedKeys = isSplitEnvelope
    ? ['id', 'mc', 'miv', 'sc', 'siv']
    : hasTimestamp ? ['id', 'c', 'iv', 't'] : ['id', 'c', 'iv'];
  const actualKeys = Object.keys(parsedData);
  if (actualKeys.length !== allowedKeys.length || actualKeys.some(k => !allowedKeys.includes(k))) {
    return error(`Invalid data fields: expected exactly [${allowedKeys.join(', ')}]`, 400);
  }

  if (typeof parsedData.id !== 'string') {
    return error('Invalid data structure: id (string) required', 400);
  }

  /** ciphertext+iv pair: non-empty strings, valid base64, iv exactly 12 bytes. */
  const checkEnvelope = (cName: string, cVal: unknown, ivName: string, ivVal: unknown): Response | null => {
    if (typeof cVal !== 'string' || typeof ivVal !== 'string') {
      return error(`Invalid data structure: ${cName}, ${ivName} (strings) required`, 400);
    }
    if (cVal.length === 0 || ivVal.length === 0) {
      return error(`Invalid data: ${cName} and ${ivName} must be non-empty`, 400);
    }
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(ivVal);
      base64ToBytes(cVal); // validate base64
    } catch {
      return error(`Invalid data: ${cName} and ${ivName} must be base64`, 400);
    }
    if (bytes.length !== 12) return error(`Invalid data: ${ivName} must be 12 bytes`, 400);
    return null;
  };

  if (isSplitEnvelope) {
    // BOTH halves are validated identically — a v4 record with a well-formed
    // meta blob and a garbage secret blob must never be posted (the client's
    // restore rejects such a candidate wholesale, so it would be dead weight
    // on-chain, permanently).
    const metaBad = checkEnvelope('mc', parsedData.mc, 'miv', parsedData.miv);
    if (metaBad) return metaBad;
    const secretBad = checkEnvelope('sc', parsedData.sc, 'siv', parsedData.siv);
    if (secretBad) return secretBad;
  } else {
    const bad = checkEnvelope('c', parsedData.c, 'iv', parsedData.iv);
    if (bad) return bad;
    if (hasTimestamp && typeof parsedData.t !== 'number') {
      return error('Invalid data structure: t (number) required for v1', 400);
    }
  }

  // Cross-check tags ↔ data
  if (tagMap.get('Note-Id') !== parsedData.id) return error('Note-Id mismatch', 400);
  if (tagMap.get('Owner-Hash') !== ownerHash) return error('Owner-Hash mismatch', 400);
  if (hasTimestamp && tagMap.get('Timestamp') !== String(parsedData.t)) {
    return error('Timestamp mismatch', 400);
  }

  // UUID namespace barrier (mixed-client protection): v3/v4 ids live in a
  // DISJOINT namespace (UUIDv8) from v1/v2 (UUIDv4). A stale pre-v3 client tab
  // that reads a v3 record from shared IndexedDB and serializes it as v1 sends
  // a v8 id under App-Version=1 — rejected HERE, before the per-owner DO, so
  // the permanent noteId idempotency can never commit garbage ciphertext.
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-([0-9a-f])[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const uuidMatch = uuidRegex.exec(parsedData.id);
  if (!uuidMatch) return error('Note-Id must be a valid UUID', 400);
  const uuidVersion = uuidMatch[1].toLowerCase();
  const expectedUuidVersion = (declaredVersion === '3' || declaredVersion === '4') ? '8' : '4';
  if (uuidVersion !== expectedUuidVersion) {
    return error(`Note-Id must be a UUIDv${expectedUuidVersion} for App-Version ${declaredVersion}`, 400);
  }

  // Upload kill switch (v3 only) — checked AFTER auth + full schema validation,
  // BEFORE any per-owner RateLimiter DO call and before the Arweave POST. When
  // disabled, ALL v3 traffic (including reconciliation of committed/reserved
  // states and recovery hints) pauses until re-enabled: /check-and-reserve
  // mutates state even on a lookup, so no disabled branch may reach the DO.
  if (declaredVersion === '3' && !v3UploadsEnabled(env)) {
    return new Response(JSON.stringify({ code: 'v3_uploads_disabled' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Same contract for v4 (safebox), on its OWN switch: one version's pause must
  // never stop the other. Deliberately 503 (never 403 — the client reads 403 as
  // "not registered" and drops its registration marker).
  if (declaredVersion === '4' && !v4UploadsEnabled(env)) {
    return new Response(JSON.stringify({ code: 'v4_uploads_disabled' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 10. Idempotency + rate limit + reserve (C1/M6 lifecycle).
  const limiterStub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(publicKeyB64));
  const noteId = parsedData.id;
  const doCall = (path: string, payload: unknown) =>
    limiterStub.fetch(new Request(`http://internal${path}`, {
      method: 'POST', body: JSON.stringify(payload),
    }));

  // Releasing must never throw out of the failure path — the reservation frees
  // itself via TTL anyway, so a DO hiccup here shouldn't turn a 502 into a 500.
  const safeRelease = async (token: string) => {
    try { await doCall('/release', { noteId, token }); }
    catch (e) { console.error('RELEASE_FAILED', noteId, e); }
  };

  // Convert a dropped server TX back to a fresh reservation for re-post.
  const doRedrop = async (deadTxId: string):
    Promise<{ kind: 'resolved'; txId: string } | { kind: 'defer' } | { kind: 'repost'; token: string }> => {
    const resp = await doCall('/redrop', { noteId, txId: deadTxId, limit: quotaLimit, fp: requestedFp });
    const r: { ok: boolean; token?: string; rateLimited?: boolean; inProgress?: boolean; committed?: boolean; txId?: string } = await resp.json();
    if (r.committed && r.txId) return { kind: 'resolved', txId: r.txId }; // reposted elsewhere
    if (r.rateLimited || r.inProgress || !r.ok || !r.token) return { kind: 'defer' };
    return { kind: 'repost', token: r.token };
  };

  // The fingerprint of the payload THIS request carries. Computed from the
  // outer `data` and the declared version — the immutable half of a
  // publication — so two attempts at publishing the same record agree while a
  // different record under a reused id does not.
  let requestedFp: string;
  try {
    requestedFp = await computePublicationFp(declaredVersion, data);
  } catch {
    // Unreachable after the validation above; fail closed rather than reserve
    // without a fingerprint, which would write a legacy-shaped record.
    return error('Payload could not be fingerprinted', 400);
  }

  type CheckResult = {
    status: string;
    txId?: string;
    committedAt?: number;
    postedAt?: number;
    token?: string;
    state?: string;
    snapshot?: LegacySnapshot;
  };

  /**
   * Resolve a LEGACY record: authenticate the publication (D9) and record what
   * it actually is, so the comparison can happen on the next pass.
   *
   * Returns a Response to send, or null meaning «resolved, ask the DO again».
   */
  const resolveLegacy = async (snapshot: LegacySnapshot): Promise<Response | null> => {
    const auth = await authenticatePublication(snapshot.txId, {
      origins: payloadOrigins(env),
      trustedOwners,
      ownerHash,
    });

    if (auth.kind === 'unproven') {
      // Absence of evidence from the pool is a TRANSPORT failure. Turning it
      // into a verdict would let a bad afternoon on the gateway network
      // permanently damage a healthy record. Nothing is written.
      return error('Publication could not be authenticated', 503);
    }
    if (auth.kind === 'not-ours') {
      // PROVEN to be something else: another wallet, another vault, or a body
      // this canonicalization cannot read. Not transient, so a 503 would loop
      // forever — and the historical txId must never be returned as a success.
      // Nothing is written: no observedFp, no binding.
      return idPayloadConflict(snapshot.txId);
    }

    // Proven. The fingerprint is recorded WHATEVER the comparison then says —
    // the verification is expensive and its result is a fact about the
    // publication, not a verdict about this request.
    await doCall('/backfill-fp', { noteId, snapshot, observedFp: auth.observedFp });
    return null;
  };

  let checkResp = await doCall('/check-and-reserve', { noteId, limit: quotaLimit, fp: requestedFp });
  let checkResult: CheckResult = await checkResp.json();

  if (checkResult.status === 'legacy' && checkResult.snapshot) {
    const resolved = await resolveLegacy(checkResult.snapshot);
    if (resolved) return resolved;
    // Exactly ONE retry. The record is no longer legacy (this backfill filled
    // it, or a concurrent one did), so a second `legacy` would mean the record
    // is being rewritten under us — and looping on that is how a retry storm
    // starts. Whatever the DO says now is the answer.
    checkResp = await doCall('/check-and-reserve', { noteId, limit: quotaLimit, fp: requestedFp });
    checkResult = await checkResp.json();
    if (checkResult.status === 'legacy') return error('Record is being reconciled, retry', 503);
  }

  if (checkResult.status === 'id_payload_conflict') {
    // The same noteId under DIFFERENT bytes. Typed, never a silent replay of
    // the historical txId.
    return idPayloadConflict(checkResult.txId);
  }

  let reserveToken: string;
  // True whenever the upcoming POST creates a NEW paid txId after a PROVEN
  // dead (the event's definition): both /redrop branches AND the
  // recovery-hint branch (dead verdict + age guard). A successful POST then
  // additionally emits redrop_new_tx.
  let viaRedrop = false;

  if (checkResult.status === 'exists') {
    // Already committed. Without recheck this is the idempotent happy path.
    if (!wantsRecheck) {
      // The idempotent happy path: an existing transaction, PROVEN to be this
      // payload (the fp comparison above). `deduped` is additive — an older
      // client ignores it, which is safe precisely because the proof was done
      // by the server, not asserted by the client.
      return json({ txId: checkResult.txId, status: 'accepted', committed: true, deduped: true });
    }

    // Recheck: is the committed TX still alive on-chain?
    const live = await getTxStatusWorker(checkResult.txId!, emit, env);
    if (live === 'alive') {
      return json({ txId: checkResult.txId, status: 'accepted', committed: true, deduped: true });
    }
    if (live === 'unavailable') return error('Arweave status unavailable', 503);
    if (Date.now() - (checkResult.committedAt ?? 0) <= MIN_COMMITTED_AGE_MS) {
      return error('Recheck deferred: committed too recently', 503); // race guard
    }
    const rd = await doRedrop(checkResult.txId!);
    if (rd.kind === 'resolved') {
      // Superseded: another request committed this payload while we were
      // deciding. This response paid for nothing, so it is a dedupe.
      return json({ txId: rd.txId, status: 'accepted', committed: true, deduped: true });
    }
    if (rd.kind === 'defer') return error('Recheck deferred', 503);
    reserveToken = rd.token;
    viaRedrop = true;
  } else if (checkResult.status === 'posted') {
    // POST succeeded but the commit was lost. Reconcile using the SERVER's txId
    // (never a client-supplied one), its CAS token, and the postedAt age guard.
    const live = await getTxStatusWorker(checkResult.txId!, emit, env);
    if (live === 'unavailable') return error('Arweave status unavailable', 503);
    if (live === 'alive') {
      try {
        const commitResp = await doCall('/commit', { noteId, txId: checkResult.txId, token: checkResult.token });
        const commit: { ok: boolean } = await commitResp.json();
        if (commitResp.ok && commit.ok) {
          // `deduped` only NOW: the posted state has been resolved — liveness
          // checked and the DO finalized — which is what the plan requires
          // before this answer may be given.
          return json({ txId: checkResult.txId, status: 'accepted', committed: true, deduped: true });
        }
      } catch { /* fall through to retryable 503 */ }
      return error('Recheck deferred', 503); // raced / DO error — retry
    }
    if (Date.now() - (checkResult.postedAt ?? 0) <= MIN_COMMITTED_AGE_MS) {
      return error('Recheck deferred: posted too recently', 503);
    }
    const rd = await doRedrop(checkResult.txId!);
    if (rd.kind === 'resolved') {
      // Superseded: another request committed this payload while we were
      // deciding. This response paid for nothing, so it is a dedupe.
      return json({ txId: rd.txId, status: 'accepted', committed: true, deduped: true });
    }
    if (rd.kind === 'defer') return error('Recheck deferred', 503);
    reserveToken = rd.token;
    viaRedrop = true;
  } else if (checkResult.status === 'reserved') {
    return error('Upload already in progress for this noteId', 409);
  } else if (checkResult.status === 'rate_limited') {
    return error('Rate limit exceeded', 429);
  } else {
    reserveToken = checkResult.token!;

    // Triple-failure recovery: the DO has no record, but the client holds a
    // server-signed recovery token for a previously-posted txId. Verify the HMAC,
    // then reconcile like the posted path — never re-post an alive TX.
    if (wantsRecheck && recoveryHint) {
      // FAIL CLOSED: a bad HMAC (corrupt, forged, or signed under a rotated /
      // missing secret) releases the fresh reservation and 400s — it must NOT
      // fall through to a new post while the referenced TX may be alive.
      const recoveryValid = await verifyRecovery(env, noteId, recoveryHint.txId, recoveryHint.postedAt, recoveryHint.token);
      if (!recoveryValid) {
        await safeRelease(reserveToken);
        // Same structured body as the malformed-hint branch above: both
        // "Invalid recovery token" responses must carry the SAME code.
        return recoveryInvalid();
      }
      const live = await getTxStatusWorker(recoveryHint.txId, emit, env);
      if (live === 'unavailable') { await safeRelease(reserveToken); return error('Arweave status unavailable', 503); }
      if (live === 'alive') {
        // The token proves noteId, txId and postedAt — it says NOTHING about
        // the bytes. Committing here binds THIS request's fingerprint to that
        // historical txId, so without authenticating the publication it would
        // mint exactly the pair the floors forbid: payload B under transaction
        // A, signed off by the server. So this branch runs the SAME proof as
        // the legacy backfill, or it refuses.
        const auth = await authenticatePublication(recoveryHint.txId, {
          origins: payloadOrigins(env),
          trustedOwners,
          ownerHash,
        });
        if (auth.kind === 'unproven') {
          await safeRelease(reserveToken);
          return error('Publication could not be authenticated', 503);
        }
        if (auth.kind !== 'authenticated' || auth.observedFp !== requestedFp) {
          // Proven to be different bytes (or not ours at all). The reservation
          // is released and NOTHING is bound to the old transaction.
          await safeRelease(reserveToken);
          return idPayloadConflict(recoveryHint.txId);
        }
        try {
          const commitResp = await doCall('/commit', { noteId, txId: recoveryHint.txId, token: reserveToken });
          const commit: { ok: boolean } = await commitResp.json();
          if (commitResp.ok && commit.ok) {
            // The recovery branch reconciles an EXISTING transaction, so this
            // too returns an id it did not create.
            return json({ txId: recoveryHint.txId, status: 'accepted', committed: true, deduped: true });
          }
        } catch { /* fall through */ }
        await safeRelease(reserveToken);
        return error('Recheck deferred', 503);
      }
      // dead — only re-post once past the age guard (uses signed postedAt).
      if (Date.now() - recoveryHint.postedAt <= MIN_COMMITTED_AGE_MS) {
        await safeRelease(reserveToken);
        return error('Recheck deferred: posted too recently', 503);
      }
      // dead & old enough → fall through to re-post under reserveToken.
      // This IS a new paid txId after a proven dead — same event as /redrop
      // (missing it would hide exactly the riskiest triple-failure scenario
      // from the security metric).
      viaRedrop = true;
    }
  }

  // 11. Create + sign + post the Arweave TX. Any failure releases the reservation
  //     (quota is not spent, so the note can be retried) and returns 502.
  //     PR-2: anchor and price are EXPLICIT (transport adapter) and handed to
  //     createTransaction pre-loaded as {last_tx, reward} — the SDK makes no
  //     hidden network calls. Status codes, safeRelease and error texts are
  //     unchanged; the POST deliberately still has NO timeout (a response lost
  //     to our own timeout would not prove the gateway rejected the TX — see
  //     postSignedTx).
  let txId: string;
  const transportDeps = { host: ARWEAVE_HOST, emit };
  try {
    const arweave = getArweave();
    const serverWallet = assertStructurallyCompleteJwk(env.ARWEAVE_JWK);
    const last_tx = await getAnchor(transportDeps);
    // Exactly the byte count the SDK itself would price — the UTF-8 length of
    // the data string (arweave/node/common.js: stringToBuffer(data).byteLength).
    // An underpriced reward is a network-rejected transaction.
    const reward = await getPrice(new TextEncoder().encode(data).byteLength, transportDeps);
    const tx = await arweave.createTransaction({ data, last_tx, reward }, serverWallet);
    for (const tag of tags) tx.addTag(tag.name, tag.value);
    await arweave.transactions.sign(tx, serverWallet);
    const response = await postSignedTx(arweave, tx, transportDeps);
    if (response.status !== 200 && response.status !== 202) {
      await safeRelease(reserveToken);
      emit('upload_outcome', ['arweave_error', declaredVersion], []);
      return error(`Arweave error: ${response.status}`, 502);
    }
    // post_accepted = the gateway ACCEPTED the POST — before mark-posted/commit.
    emit('post_accepted', [ARWEAVE_HOST], []);
    if (viaRedrop) emit('redrop_new_tx', [ARWEAVE_HOST], []);
    txId = tx.id;
  } catch (e) {
    await safeRelease(reserveToken);
    console.error('ARWEAVE_POST_FAILED', noteId, e);
    emit('upload_outcome', ['arweave_throw', declaredVersion], []);
    return error('Arweave upload failed', 502);
  }

  // 12a. Anchor the POST in the DO BEFORE commit (retry). This is the
  //      server-authoritative record that makes a lost commit reconcilable.
  //      Checked on resp.ok AND body.ok (a stale body must not count as anchored).
  const postedAt = Date.now();
  let anchored = false;
  for (let attempt = 0; attempt < 3 && !anchored; attempt++) {
    try {
      const resp = await doCall('/mark-posted', { noteId, txId, token: reserveToken });
      const body: { ok: boolean } = await resp.json();
      if (resp.ok && body.ok) anchored = true;
    } catch { /* retry */ }
    if (!anchored && attempt < 2) await new Promise(r => setTimeout(r, 100 * Math.pow(3, attempt)));
  }

  // 12b. Commit noteId → txId — retry, checking resp.ok / stale (L7).
  let committed = false;
  for (let attempt = 0; attempt < 3 && !committed; attempt++) {
    try {
      const commitResp = await doCall('/commit', { noteId, txId, token: reserveToken });
      const commit: { ok: boolean; stale?: boolean } = await commitResp.json();
      if (commitResp.ok && commit.ok) committed = true;
      else if (commit.stale) break; // reservation superseded — do not keep retrying
    } catch {
      if (attempt < 2) await new Promise(r => setTimeout(r, 100 * Math.pow(3, attempt)));
    }
  }

  // upload_outcome=accepted fires ONLY on terminal returns of the PAID path —
  // a 200 /upload after a POST actually performed by THIS request. Early
  // returns (validation 4xx, kill switches, 429, idempotent hits,
  // reconciliation without a new POST) deliberately emit nothing: the metric
  // answers "how do paid publications end", not "how do requests end".
  if (committed) {
    emit('upload_outcome', ['accepted', declaredVersion], []);
    return json({ txId, status: 'accepted', committed: true, deduped: false });
  }

  // Not committed. If it's ANCHORED, the DO holds a `posted` record → the client
  // just keeps needsRecheck and reconciles server-side. If NOT anchored, the DO
  // has no record at all — hand out a signed recovery token so the client can
  // prove this txId later instead of triggering a duplicate re-post.
  if (anchored) {
    console.error(`COMMIT_FAILED noteId=${noteId} txId=${txId}`);
    emit('upload_outcome', ['accepted', declaredVersion], []);
    return json({ txId, status: 'accepted', committed: false, deduped: false });
  }
  console.error(`ANCHOR_AND_COMMIT_FAILED noteId=${noteId} txId=${txId}`);
  // accepted is emitted only AFTER signRecovery resolves: should WebCrypto
  // reject, the request would not end in a terminal paid-path 200, and the
  // metric must not have claimed one.
  const recoveryToken = await signRecovery(env, noteId, txId, postedAt);
  emit('upload_outcome', ['accepted', declaredVersion], []);
  if (recoveryToken === null) {
    // Unreachable: the step-0 gate 503s uploads without RECOVERY_HMAC_SECRET.
    // Kept as defense in depth — never imply a hint exists when it doesn't.
    return json({ txId, status: 'accepted', committed: false, deduped: false });
  }
  return json({
    txId, status: 'accepted', committed: false, deduped: false,
    recovery: { txId, postedAt, token: recoveryToken },
  });
}

// ─── Helpers ────────────────────────────────────────────────────────

function corsHeaders(origin: string, allowedOrigins: string[]): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Public-Key, X-Signature',
  };
  if (allowedOrigins.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

function addCors(response: Response, origin: string, allowedOrigins: string[]): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders(origin, allowedOrigins))) {
    headers.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function handleOptions(origin: string, allowedOrigins: string[]): Response {
  return new Response(null, { status: 204, headers: corsHeaders(origin, allowedOrigins) });
}

/**
 * `/health` answers with `no-store`. This endpoint decides whether a persisted
 * upload pause may be lifted, so a cached answer is not a stale diagnostic — it
 * is a resume decision made on a state that may no longer exist.
 */
function healthJson(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/**
 * First 16 hex of SHA-256 over the canonical, SORTED serialization of the
 * configured status origins. Sorted because the status order is not normative,
 * so reordering `wrangler.toml` must not change the value the deploy smoke
 * compares against the hash it computes from that same file.
 */
async function statusGatewaysHash(origins: readonly string[]): Promise<string> {
  const bytes = new TextEncoder().encode(serializeStatusOrigins(origins));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

/**
 * The typed refusal for «this noteId already names DIFFERENT bytes» (D2).
 *
 * 409 and a machine-readable `code`, never a 200 carrying the historical
 * `txId`: that pair — payload B under transaction A — is precisely what the two
 * irreversible floors exist to make impossible, and a client that cannot tell
 * it from success would store it.
 */
function idPayloadConflict(txId: string | undefined): Response {
  return new Response(JSON.stringify({ code: 'id_payload_conflict', ...(txId ? { txId } : {}) }), {
    status: 409,
    headers: { 'Content-Type': 'application/json' },
  });
}

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
  });
}

function error(message: string, status: number): Response {
  return new Response(message, { status });
}

/** Both `Invalid recovery token` branches answer with THIS response: HTTP 400
 *  plus a machine-readable {code} so a new client can distinguish an
 *  invalidated recovery proof (→ terminal quarantine, §1.9) from a generic
 *  error, while an old client still sees a 400 with readable text. */
function recoveryInvalid(): Response {
  return new Response(
    JSON.stringify({ code: 'recovery_invalid', error: 'Invalid recovery token' }),
    { status: 400, headers: { 'Content-Type': 'application/json' } },
  );
}

/** Anti-replay freshness: a real number within ±5 min (rejects NaN/non-number). */
function isFreshTimestamp(ts: unknown): boolean {
  return typeof ts === 'number' && Number.isFinite(ts) && Math.abs(Date.now() - ts) <= 300_000;
}

/** GLOBAL upload kill switch (incident lever). STRICTLY "true" enables — a
 *  missing, empty, or garbage value fails CLOSED (all uploads disabled).
 *  See Env.UPLOADS_ENABLED. */
function uploadsEnabled(env: Env): boolean {
  return env.UPLOADS_ENABLED === 'true';
}

/** v3 upload kill switch. STRICTLY "true" enables — a missing, empty, or
 *  garbage value fails CLOSED (disabled). See Env.V3_UPLOADS_ENABLED. */
function v3UploadsEnabled(env: Env): boolean {
  return env.V3_UPLOADS_ENABLED === 'true';
}

/** v4 (safebox) upload kill switch. STRICTLY "true" enables — a missing, empty,
 *  or garbage value fails CLOSED (disabled). See Env.V4_UPLOADS_ENABLED. */
function v4UploadsEnabled(env: Env): boolean {
  return env.V4_UPLOADS_ENABLED === 'true';
}

/** Parse a required positive-integer config value. Returns null (→ fail closed,
 *  503) on missing/NaN/non-integer/≤0 — never silently disables a limit. */
function parsePositiveInt(v: string | undefined): number | null {
  if (typeof v !== 'string' || v.trim() === '') return null;
  const n = Number(v);
  // Safe-integer + sane upper bound so a huge/garbage value can't wrap or DoS.
  return Number.isSafeInteger(n) && n > 0 && n <= 100_000_000 ? n : null;
}

// ─── Recovery token (HMAC) ──────────────────────────────────────────
// Covers the rare triple-failure: POST ok, but mark-posted AND commit both fail,
// so the DO has no record of the txId. We hand the client a SERVER-SIGNED token
// binding {noteId, txId, postedAt}; on reconciliation the client returns it and
// we verify the HMAC — so it can prove which TX is ours WITHOUT us trusting an
// arbitrary client-supplied txId.
//
// The HMAC key comes from the DEDICATED RECOVERY_HMAC_SECRET (stable across
// ARWEAVE_JWK rotations — a wallet rotation must not orphan outstanding tokens).
// The secret is MANDATORY: /upload 503s without it (step-0 gate), because an
// unrecoverable triple-failure would otherwise end in a duplicate paid POST.
// The null-handling below is defense in depth for any other caller.
let recoveryKeyPromise: Promise<CryptoKey> | null = null;
function getRecoveryKey(env: Env): Promise<CryptoKey> | null {
  if (!env.RECOVERY_HMAC_SECRET) return null;
  if (!recoveryKeyPromise) {
    recoveryKeyPromise = (async () => {
      const material = new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.RECOVERY_HMAC_SECRET + ':recovery')),
      );
      return crypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    })();
  }
  return recoveryKeyPromise;
}
/** Returns null when RECOVERY_HMAC_SECRET is unset. NOT a supported mode —
 *  the /upload step-0 gate 503s before anything can be posted without the
 *  secret; this null path exists purely as defense in depth. */
async function signRecovery(env: Env, noteId: string, txId: string, postedAt: number): Promise<string | null> {
  const keyPromise = getRecoveryKey(env);
  if (!keyPromise) return null;
  const key = await keyPromise;
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${noteId}:${txId}:${postedAt}`));
  return bytesToBase64(new Uint8Array(sig));
}
async function verifyRecovery(env: Env, noteId: string, txId: string, postedAt: number, token: string): Promise<boolean> {
  try {
    const keyPromise = getRecoveryKey(env);
    if (!keyPromise) return false; // no secret → cannot verify → fail closed
    const key = await keyPromise;
    const expected = new Uint8Array(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${noteId}:${txId}:${postedAt}`)),
    );
    const provided = base64ToBytes(token);
    if (provided.length !== expected.length) return false;
    return crypto.subtle.timingSafeEqual(expected, provided);
  } catch {
    return false;
  }
}

/**
 * Server-side liveness check for a committed TX (recheck path). Maps the gateway
 * contract to a coarse verdict: 200/202 → alive, 404/400 → dead, else unknown.
 * PR-2 wraps the SAME fetch in a stopwatch and emits gateway_call(status) +
 * status_verdict; the verdict logic itself is unchanged (quorum is PR-3a).
 */
async function getTxStatusWorker(
  txId: string,
  emit: Emit,
  env: Env,
): Promise<'alive' | 'dead' | 'unavailable'> {
  const origins = statusOrigins(env);
  const votes = await Promise.all(origins.map(origin => probeStatusOrigin(origin, txId, emit)));

  // The SHARED formula — literally the module the client runs (src/lib/
  // status-quorum.ts). One implementation, so the two halves cannot drift into
  // reaching verdicts the other could not.
  const verdict = statusVerdict(origins, votes);

  // The quorum row uses a sentinel HOST rather than a new blob, so the schema
  // is unchanged. A leading underscore cannot occur in a bare origin, so it can
  // never collide with a real gateway's series.
  const coarse: 'alive' | 'dead' | 'unavailable' =
    verdict.kind === 'confirmed' || verdict.kind === 'pending' ? 'alive'
      : verdict.kind === 'dead' ? 'dead'
        : 'unavailable';
  emit('status_verdict', [coarse, QUORUM_METRIC_HOST],
    [verdict.kind === 'confirmed' ? verdict.confirmations : -1]);
  return coarse;
}

/** Sentinel host for the aggregated row (see getTxStatusWorker). */
const QUORUM_METRIC_HOST = '_quorum';

/** Configured status origins, defaulting to the single legacy host. Canonized
 *  and deduplicated with the SAME parser the client compiles in. */
function statusOrigins(env: Env): string[] {
  const parsed = parseOriginList(env.STATUS_GATEWAYS ?? '');
  return parsed.length > 0 ? parsed : [`https://${ARWEAVE_HOST}`];
}

/** Configured payload origins for D9, in the pinned ORDER (unlike the status
 *  pool, whose probes run in parallel and whose order carries no meaning). */
export function payloadOrigins(env: Env): string[] {
  const parsed = parseOriginList(env.PAYLOAD_GATEWAYS ?? '');
  return parsed.length > 0 ? parsed : [`https://${ARWEAVE_HOST}`];
}

/**
 * One origin's answer. Emits the per-host metrics PR-2 introduced — the `host`
 * label stays a BARE hostname (`arweave.net`), not the canonical origin, so the
 * historical time series is not split in half by this change.
 *
 * 400 is no longer `dead`: it is a non-404 outcome like any other, and under
 * the quorum it now BLOCKS dead instead of causing it.
 */
async function probeStatusOrigin(origin: string, txId: string, emit: Emit): Promise<StatusVote> {
  const host = new URL(origin).host;
  const started = performance.now();
  let r: Response;
  try {
    r = await fetch(`${origin}/tx/${txId}/status`, {
      method: 'GET',
      // NO REDIRECTS — and this is the half that spends money. `fetch` follows
      // them by default, so a gateway answering 302 -> another gateway would
      // give TWO configured origins carrying ONE host's opinion, and unanimity
      // over the pool is exactly what authorizes a paid redrop. The client was
      // fixed first; leaving the authoritative side unfixed fixed nothing.
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    emit('gateway_call', ['status', host, classifyThrow(e)], [performance.now() - started]);
    emit('status_verdict', ['unavailable', host], [-1]);
    return { origin, kind: 'other' };
  }
  const elapsed = performance.now() - started;

  if (r.status === 202) {
    emit('gateway_call', ['status', host, classifyStatus(r.status)], [elapsed]);
    emit('status_verdict', ['alive', host], [-1]);
    return { origin, kind: 'pending' };
  }
  if (r.status === 404) {
    emit('gateway_call', ['status', host, classifyStatus(r.status)], [elapsed]);
    emit('status_verdict', ['dead', host], [-1]);
    return { origin, kind: 'dead404' };
  }
  if (r.status !== 200) {
    emit('gateway_call', ['status', host, classifyStatus(r.status)], [elapsed]);
    emit('status_verdict', ['unavailable', host], [-1]);
    return { origin, kind: 'other' };
  }

  // A 200 must carry a body that satisfies the schema to count as alive. A
  // malformed one is a PROTOCOL defect (`invalid_response`), never a verdict.
  let confirmations = -1;
  let blockHeight = -1;
  try {
    const text = await readCappedText(r, 1024);
    if (text !== null) {
      const doc: unknown = JSON.parse(text);
      if (typeof doc === 'object' && doc !== null) {
        const d = doc as { number_of_confirmations?: unknown; block_height?: unknown };
        if (safeCount(d.number_of_confirmations) && safeCount(d.block_height)) {
          confirmations = d.number_of_confirmations;
          blockHeight = d.block_height;
        }
      }
    }
  } catch { /* stays −1 → invalid_response below */ }

  if (confirmations < 0) {
    emit('gateway_call', ['status', host, 'invalid_response'], [elapsed]);
    emit('status_verdict', ['unavailable', host], [-1]);
    return { origin, kind: 'other' };
  }
  emit('gateway_call', ['status', host, classifyStatus(r.status)], [elapsed]);
  emit('status_verdict', ['alive', host], [confirmations]);
  return { origin, kind: 'confirmed', confirmations, blockHeight };
}

function safeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Per-IP baseline rate limit (D-baseline). Call at the START of protected
 * handlers — after route/method dispatch, before body read / signature / KV / DO.
 * Fails CLOSED (503) if the sharded IpRateLimiter DO is unreachable, since on
 * Free this is the primary anti-abuse layer.
 * Returns a Response to short-circuit, or null to continue.
 */
async function enforceIpLimit(request: Request, env: Env, bucket: 'main' | 'diag' = 'main'): Promise<Response | null> {
  // CF-Connecting-IP is set by Cloudflare at the edge and cannot be spoofed by
  // the client. Absent only in local dev → shared 'unknown' bucket (still limited).
  // `bucket` shards the limiter per purpose: the public GET /wallet-address uses
  // 'diag' so a third-party page firing no-preflight GETs cannot exhaust the
  // SAME budget the user's upload/register traffic depends on.
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const shard = bucket === 'main' ? ip : `${bucket}:${ip}`;
  try {
    const stub = env.IP_RATE_LIMITER.get(env.IP_RATE_LIMITER.idFromName(shard));
    const resp = await stub.fetch('http://ip-limiter/check', {
      method: 'POST',
      body: JSON.stringify({ limit: IP_RATE_LIMIT, windowMs: IP_RATE_WINDOW_MS }),
    });
    if (resp.status === 429) return error('Too many requests from this IP', 429);
    if (!resp.ok) return error('Rate limiter unavailable', 503); // fail-closed
    return null;
  } catch {
    return error('Rate limiter unavailable', 503); // fail-closed
  }
}

/**
 * Verify Ed25519 signature over SHA-256(bodyText).
 * Returns a Response on failure, null on success.
 */
async function verifySignature(
  publicKeyB64: string,
  signatureB64: string,
  bodyText: string,
): Promise<Response | null> {
  let publicKey: Uint8Array, signature: Uint8Array;
  try {
    publicKey = base64ToBytes(publicKeyB64);
    signature = base64ToBytes(signatureB64);
    if (publicKey.length !== 32 || signature.length !== 64) throw new Error('bad length');
  } catch {
    return error('Invalid key/signature format', 400);
  }

  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bodyText))
  );
  const valid = await ed25519.verifyAsync(signature, digest, publicKey);
  if (!valid) return error('Invalid signature', 401);

  return null; // success
}

/**
 * Read a request body with a HARD size cap that never buffers the whole
 * payload. The declared Content-Length is a fast-reject; then the body is
 * consumed CHUNK BY CHUNK and the stream is cancel()led the instant the running
 * total exceeds maxBytes — a request with no Content-Length or a lying one
 * cannot exhaust Worker memory. Returns the decoded text or the 413 Response.
 */
async function readLimitedBody(
  request: Request,
  maxBytes: number,
): Promise<{ text: string } | { tooLarge: Response }> {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { tooLarge: error('Body too large', 413) };
  }

  if (!request.body) {
    return { text: await request.text() }; // no stream (e.g. empty body)
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel(); // stop pulling — don't materialise the rest
        return { tooLarge: error('Body too large', 413) };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { buf.set(c, offset); offset += c.byteLength; }
  return { text: new TextDecoder().decode(buf) };
}

/** Canonical base64 of exactly 32 bytes (an Ed25519 public key): decodes,
 *  length-checks, and round-trips back to the identical string — so padding
 *  tricks or noncanonical encodings of the same key can't slip past. */
function isValidPublicKeyB64(s: string): boolean {
  if (s.length === 0 || s.length > 64) return false; // 32 bytes → 44 chars
  try {
    const bytes = base64ToBytes(s);
    if (bytes.length !== 32) return false;
    return bytesToBase64(bytes) === s;
  } catch {
    return false;
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
