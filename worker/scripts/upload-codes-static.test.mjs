import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';

// Static guard over worker/src/index.ts (plan «soak D2 operation journal»
// v6.1 §3.1, tests 8 and 11): every /upload answer code is one of the closed
// lists in upload-codes.json, on the right side of the admission; the handler
// answers nothing through the plain-text error() helper; and the token-CAS
// abort is only ever called BEFORE the POST. Runs under the ROOT vitest (plain
// Node) — the workers pool has no node:fs.

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'src', 'index.ts'), 'utf8');
const codes = JSON.parse(readFileSync(join(here, '..', 'src', 'upload-codes.json'), 'utf8'));

const handlerStart = src.indexOf('async function handleUpload(request: Request, env: Env): Promise<Response> {');
const handlerEnd = src.indexOf('// ─── Helpers ───', handlerStart);
const handler = src.slice(handlerStart, handlerEnd);
const admissionAt = handler.indexOf("doCall('/check-and-reserve'");
// The handler defines `resolveLegacy` (a closure the ADMITTED path runs) before
// the admission call textually. Everything from that definition on is
// post-admission machinery; every answer before it is a pre-admission refusal.
const boundaryAt = handler.indexOf('const resolveLegacy = async (');
// The three refusals the admission itself answers — refused, not admitted —
// live after step 10 but carry pre-admission codes by design.
const ADMISSION_REFUSALS = new Set(['operation_id_reused', 'audit_unavailable', 'audit_unconfirmed']);

const pre = new Map(codes.preAdmission.map(c => [c.code, c.status]));
const post = new Map(codes.postAdmission.map(c => [c.code, c.status]));

describe('upload-codes.json', () => {
  it('has the shape the driver relies on: snake_case codes, valid statuses, no duplicate pairs per list', () => {
    for (const list of [codes.preAdmission, codes.postAdmission]) {
      expect(Array.isArray(list)).toBe(true);
      const seen = new Set();
      for (const { code, status } of list) {
        expect(code).toMatch(/^[a-z][a-z0-9_]{2,40}$/);
        expect(Number.isInteger(status) && status >= 400 && status <= 599).toBe(true);
        expect(seen.has(code)).toBe(false);
        seen.add(code);
      }
    }
  });
});

describe('handleUpload answers', () => {
  it('was found, and admits through /check-and-reserve', () => {
    expect(handlerStart).toBeGreaterThan(0);
    expect(boundaryAt).toBeGreaterThan(0);
    expect(admissionAt).toBeGreaterThan(boundaryAt);
  });

  it('never answers through the plain-text error() helper', () => {
    const plain = handler.match(/(?<![A-Za-z.])error\((?:'|`)/g) ?? [];
    expect(plain).toEqual([]);
  });

  it('every uploadError(status, code) before the admission is a preAdmission pair, and after it a postAdmission pair', () => {
    const re = /uploadError\(\s*(\d{3}),\s*'([a-z0-9_]+)'/g;
    const before = [];
    const after = [];
    for (const m of handler.matchAll(re)) {
      (m.index < boundaryAt ? before : after).push({ status: Number(m[1]), code: m[2] });
    }
    expect(before.length).toBeGreaterThan(5);
    expect(after.length).toBeGreaterThan(5);
    for (const { status, code } of before) {
      expect(pre.get(code), `pre-admission code ${code}`).toBe(status);
    }
    for (const { status, code } of after) {
      const list = ADMISSION_REFUSALS.has(code) ? pre : post;
      expect(list.get(code), `post-admission code ${code}`).toBe(status);
    }
  });

  it('dynamic-status uploadError calls (signature failure, IP block) map onto preAdmission pairs', () => {
    // verifySignature: 400 → validation_failed, 401 → auth_failed.
    expect(handler).toMatch(/verifyResult\.status === 401 \? 'auth_failed' : 'validation_failed'/);
    expect(pre.get('auth_failed')).toBe(401);
    expect(pre.get('validation_failed')).toBe(400);
    // uploadIpBlock: 429 → ip_rate_limited, otherwise rate_limiter_unavailable (503).
    expect(src).toMatch(/block\.status === 429 \? 'ip_rate_limited' : 'rate_limiter_unavailable'/);
    expect(pre.get('ip_rate_limited')).toBe(429);
    expect(pre.get('rate_limiter_unavailable')).toBe(503);
  });

  it('the router’s 415 for /upload and the recovery/conflict helpers use listed codes', () => {
    expect(src).toMatch(/uploadError\(415, 'unsupported_media_type'/);
    expect(pre.get('unsupported_media_type')).toBe(415);
    expect(src).toMatch(/code: 'recovery_invalid'/);
    expect(pre.get('recovery_invalid')).toBe(400);
    expect(post.get('recovery_invalid')).toBe(400);
    expect(src).toMatch(/code: 'id_payload_conflict'/);
    expect(post.get('id_payload_conflict')).toBe(409);
  });

  it('the token-CAS abort is called exactly once, and only BEFORE the POST (test 8)', () => {
    const abortCalls = [...handler.matchAll(/await opAbort\(/g)].map(m => m.index);
    const postCall = handler.indexOf('await postSignedTx(');
    expect(abortCalls).toHaveLength(1);
    expect(postCall).toBeGreaterThan(0);
    expect(abortCalls[0]).toBeLessThan(postCall);
    // And the DO route itself is named in one place only: the helper.
    expect(handler.match(/'\/op-abort'/g)).toHaveLength(1);
  });

  it('every admitted return goes through settle: no bare uploadAccepted/idPayloadConflict/uploadError after admission', () => {
    const afterAdmission = handler.slice(admissionAt);
    // A `return X(` where X is an answer constructor and NOT wrapped by settle(
    const bare = afterAdmission.match(/return (?:uploadAccepted|idPayloadConflict|recoveryInvalid|uploadError)\(/g) ?? [];
    // The three pre-settle admission refusals (op_reused, audit_unavailable,
    // audit_unconfirmed at begin) are the only allowed bare returns after the
    // admission call site — they ARE the «not admitted» answers.
    expect(bare.length).toBe(3);
    const allowed = afterAdmission.slice(0, afterAdmission.indexOf("if (checkResult.status === 'legacy'"));
    expect(allowed.match(/return uploadError\(/g)).toHaveLength(3);
  });
});
