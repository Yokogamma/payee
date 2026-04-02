/**
 * Eternal Notes — Cloudflare Worker Proxy
 *
 * Handles Arweave uploads (server pays AR), invite registration,
 * and registration checks. Auth via Ed25519 signature + server-side allowlist.
 */

import Arweave from 'arweave';
import * as ed25519 from '@noble/ed25519';

export { RateLimiter } from './rate-limiter';
export { InviteManager } from './invite-manager';

// ─── Types ──────────────────────────────────────────────────────────

interface Env {
  RATE_LIMITER: DurableObjectNamespace;
  INVITE_MANAGER: DurableObjectNamespace;
  ALLOWLIST: KVNamespace;
  ALLOWED_ORIGINS: string;
  MAX_BODY_BYTES: string;
  RATE_LIMIT_PER_HOUR: string;
  ARWEAVE_JWK: string;
  ADMIN_SECRET: string;
}

// ─── Entry ──────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin') || '';
    const allowedOrigins = env.ALLOWED_ORIGINS.split(',');

    if (request.method === 'OPTIONS') return handleOptions(origin, allowedOrigins);

    // All responses go through addCors() — handlers don't know about CORS
    const response = await handleRequest(request, env);
    return addCors(response, origin, allowedOrigins);
  },
};

// ─── Router ─────────────────────────────────────────────────────────

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === '/health') return json({ ok: true });

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

  return new Response('Not found', { status: 404 });
}

// ─── /admin/seed-invite ─────────────────────────────────────────────

async function handleAdminSeedInvite(request: Request, env: Env): Promise<Response> {
  const authHeader = request.headers.get('Authorization');
  if (authHeader !== `Bearer ${env.ADMIN_SECRET}`) {
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
  const result = await resp.json();
  return json(result);
}

// ─── /check-registration ────────────────────────────────────────────

async function handleCheckRegistration(request: Request, env: Env): Promise<Response> {
  const bodyText = await request.text();
  const publicKeyB64 = request.headers.get('X-Public-Key');
  const signatureB64 = request.headers.get('X-Signature');
  if (!publicKeyB64 || !signatureB64) return error('Missing auth headers', 401);

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
  if (Math.abs(Date.now() - timestamp) > 300_000) return error('Timestamp expired', 401);

  // 2. Verify Ed25519 signature — BEFORE any lookup
  const verifyResult = await verifySignature(publicKeyB64, signatureB64, bodyText);
  if (verifyResult) return verifyResult;

  // 3. Check KV cache first, then DO fallback
  let allowed = !!(await env.ALLOWLIST.get(`pk:${publicKeyB64}`));
  if (!allowed) {
    const inviteMgr = env.INVITE_MANAGER.get(env.INVITE_MANAGER.idFromName('global'));
    const checkResp = await inviteMgr.fetch(new Request('http://internal/check-allowed', {
      method: 'POST',
      body: JSON.stringify({ publicKey: publicKeyB64 }),
    }));
    const checkResult: { allowed: boolean } = await checkResp.json();
    allowed = checkResult.allowed;
    if (allowed) await env.ALLOWLIST.put(`pk:${publicKeyB64}`, 'true');
  }

  return json({ allowed });
}

// ─── /register ──────────────────────────────────────────────────────

async function handleRegister(request: Request, env: Env): Promise<Response> {
  const bodyText = await request.text();
  const publicKeyB64 = request.headers.get('X-Public-Key');
  const signatureB64 = request.headers.get('X-Signature');
  if (!publicKeyB64 || !signatureB64) return error('Missing auth headers', 401);

  // 1. Validate publicKey format
  let publicKey: Uint8Array;
  try {
    publicKey = base64ToBytes(publicKeyB64);
    if (publicKey.length !== 32) return error('Invalid publicKey length', 400);
  } catch {
    return error('Invalid publicKey format', 400);
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
  if (bodyPK !== publicKeyB64) return error('publicKey mismatch', 400);
  if (Math.abs(Date.now() - regTimestamp) > 300_000) return error('Timestamp expired', 401);

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

  // 5. Cache allowlist entry in KV
  await env.ALLOWLIST.put(`pk:${publicKeyB64}`, 'true');

  return json({ ok: true });
}

// ─── /upload ────────────────────────────────────────────────────────

async function handleUpload(request: Request, env: Env): Promise<Response> {
  // 1. Read body and check actual size
  const bodyText = await request.text();
  const actualBytes = new TextEncoder().encode(bodyText).byteLength;
  if (actualBytes > parseInt(env.MAX_BODY_BYTES)) return error('Body too large', 413);

  // 2. Parse headers + body
  const publicKeyB64 = request.headers.get('X-Public-Key');
  const signatureB64 = request.headers.get('X-Signature');
  if (!publicKeyB64 || !signatureB64) return error('Missing auth headers', 401);

  let body: {
    data: string;
    tags: { name: string; value: string }[];
    ownerHash: string;
    timestamp: number;
  };
  try {
    body = JSON.parse(bodyText);
  } catch {
    return error('Invalid JSON', 400);
  }
  const { data, tags, ownerHash, timestamp } = body;
  if (!data || !tags || !ownerHash || !timestamp) return error('Missing required fields', 400);

  // 3. Validate timestamp (5 min window)
  if (Math.abs(Date.now() - timestamp) > 300_000) return error('Timestamp expired', 401);

  // 4. Verify Ed25519 signature FIRST — before any KV/DO lookups
  const verifyResult = await verifySignature(publicKeyB64, signatureB64, bodyText);
  if (verifyResult) return verifyResult;

  // 5. Verify ownerHash = SHA-256(publicKey) (R5)
  const publicKey = base64ToBytes(publicKeyB64);
  const expectedOwnerHash = bytesToBase64(
    new Uint8Array(await crypto.subtle.digest('SHA-256', publicKey))
  );
  if (ownerHash !== expectedOwnerHash) return error('ownerHash/publicKey mismatch', 400);

  // 6. Validate publicKey in allowlist (anti-sybil, R6)
  let allowed = await env.ALLOWLIST.get(`pk:${publicKeyB64}`);
  if (!allowed) {
    const inviteMgr = env.INVITE_MANAGER.get(env.INVITE_MANAGER.idFromName('global'));
    const checkResp = await inviteMgr.fetch(new Request('http://internal/check-allowed', {
      method: 'POST',
      body: JSON.stringify({ publicKey: publicKeyB64 }),
    }));
    const checkResult: { allowed: boolean } = await checkResp.json();
    if (!checkResult.allowed) return error('Not registered', 403);
    await env.ALLOWLIST.put(`pk:${publicKeyB64}`, 'true');
  }

  // 7. Validate tags — STRICT: require EXACTLY the expected set
  const REQUIRED_TAGS = new Map<string, string>([
    ['App-Name', 'EternalNotes'],
    ['App-Version', '1'],
    ['Content-Type', 'application/json'],
  ]);
  const REQUIRED_DYNAMIC = new Set(['Owner-Hash', 'Timestamp', 'Note-Id']);
  const ALL_EXPECTED = new Set([...REQUIRED_TAGS.keys(), ...REQUIRED_DYNAMIC]);

  if (!Array.isArray(tags)) return error('tags must be an array', 400);
  if (tags.length !== ALL_EXPECTED.size) return error(`Expected exactly ${ALL_EXPECTED.size} tags`, 400);

  const tagMap = new Map<string, string>();
  for (const tag of tags) {
    if (!tag.name || typeof tag.value !== 'string') return error('Invalid tag structure', 400);
    if (!ALL_EXPECTED.has(tag.name)) return error(`Forbidden tag: ${tag.name}`, 400);
    if (tagMap.has(tag.name)) return error(`Duplicate tag: ${tag.name}`, 400);
    tagMap.set(tag.name, tag.value);
  }

  // Validate fixed-value tags
  for (const [name, expected] of REQUIRED_TAGS) {
    if (tagMap.get(name) !== expected) return error(`Invalid ${name}: expected "${expected}"`, 400);
  }

  // 8. Validate payload consistency (tags ↔ data)
  let parsedData: { id: string; c: string; iv: string; t: number };
  try {
    parsedData = JSON.parse(data);
  } catch {
    return error('Invalid data JSON', 400);
  }
  if (tagMap.get('Note-Id') !== parsedData.id) return error('Note-Id mismatch', 400);
  if (tagMap.get('Timestamp') !== String(parsedData.t)) return error('Timestamp mismatch', 400);
  if (tagMap.get('Owner-Hash') !== ownerHash) return error('Owner-Hash mismatch', 400);

  // 9. Validate data structure
  if (!parsedData.id || !parsedData.c || !parsedData.iv || typeof parsedData.t !== 'number') {
    return error('Invalid data structure: id, c, iv (strings) and t (number) required', 400);
  }
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(parsedData.id)) return error('Note-Id must be a valid UUID', 400);

  // 10. COMBINED: check idempotency + rate limit + reserve (ONE DO call, R7)
  const limiterStub = env.RATE_LIMITER.get(
    env.RATE_LIMITER.idFromName(publicKeyB64)
  );
  const checkResp = await limiterStub.fetch(new Request('http://internal/check-and-reserve', {
    method: 'POST',
    body: JSON.stringify({ noteId: parsedData.id, limit: parseInt(env.RATE_LIMIT_PER_HOUR) }),
  }));
  const checkResult: { status: string; txId?: string; remaining?: number } = await checkResp.json();

  if (checkResult.status === 'exists') {
    return json({ txId: checkResult.txId, status: 'accepted' });
  }
  if (checkResult.status === 'reserved') {
    return error('Upload already in progress for this noteId', 409);
  }
  if (checkResult.status === 'rate_limited') {
    return error('Rate limit exceeded', 429);
  }

  // 11. Create Arweave TX
  const arweave = Arweave.init({ host: 'arweave.net', port: 443, protocol: 'https' });
  const serverWallet = JSON.parse(env.ARWEAVE_JWK);
  const tx = await arweave.createTransaction({ data }, serverWallet);
  for (const tag of tags) {
    tx.addTag(tag.name, tag.value);
  }
  await arweave.transactions.sign(tx, serverWallet);
  const response = await arweave.transactions.post(tx);

  if (response.status === 200 || response.status === 202) {
    // 12. Commit noteId → txId in DO — WITH RETRY (R7 commit failure handling)
    let commitOk = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await limiterStub.fetch(new Request('http://internal/commit', {
          method: 'POST',
          body: JSON.stringify({ noteId: parsedData.id, txId: tx.id }),
        }));
        commitOk = true;
        break;
      } catch {
        if (attempt < 2) await new Promise(r => setTimeout(r, 100 * Math.pow(3, attempt)));
      }
    }
    if (!commitOk) console.error(`COMMIT_FAILED noteId=${parsedData.id} txId=${tx.id}`);
    return json({ txId: tx.id, status: 'accepted' });
  }

  return error(`Arweave error: ${response.status}`, 502);
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

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
  });
}

function error(message: string, status: number): Response {
  return new Response(message, { status });
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
