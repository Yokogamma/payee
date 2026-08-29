import { describe, it, expect } from 'vitest';
import {
  MIN_STATUS_ORIGINS,
  QUORUM_POLICY_ID,
  StatusVoteSetError,
  statusVerdict,
  toTxStatusKind,
  type StatusVote,
} from './status-quorum';

const A = 'https://arweave.net';
const B = 'https://ar-io.dev';
const C = 'https://vilenarios.com';
const D = 'https://frostor.xyz';
const E = 'https://permagate.io';
const FIVE = [A, B, C, D, E];

const dead = (origin: string): StatusVote => ({ origin, kind: 'dead404' });
const other = (origin: string): StatusVote => ({ origin, kind: 'other' });
const pending = (origin: string): StatusVote => ({ origin, kind: 'pending' });
const ok = (origin: string, confirmations: number, blockHeight: number): StatusVote =>
  ({ origin, kind: 'confirmed', confirmations, blockHeight });

describe('statusVerdict — the normative table', () => {
  it('a single valid 200 wins over anything else', () => {
    const v = statusVerdict(FIVE, [ok(A, 30, 1000), dead(B), other(C), other(D), pending(E)]);
    expect(v).toEqual({ kind: 'confirmed', confirmations: 30, blockHeight: 1000 });
  });

  it('404 + 202 → pending (a 404 never outvotes an accepted TX)', () => {
    const v = statusVerdict([A, B], [dead(A), pending(B)]);
    expect(v.kind).toBe('pending');
  });

  it('every configured origin said 404 → dead', () => {
    expect(statusVerdict(FIVE, FIVE.map(dead)).kind).toBe('dead');
  });

  // The normative example of the formula (§4.PR-3a): two agreeing 404s are NOT
  // a quorum while three origins stayed silent — that is exactly the shape a
  // correlated outage takes, and acting on it would spend money.
  it('2×404 + 3×timeout out of 5 configured → unavailable, NOT dead', () => {
    const v = statusVerdict(FIVE, [dead(A), dead(B), other(C), other(D), other(E)]);
    expect(v.kind).toBe('unavailable');
  });

  it('404 from some + any non-404 outcome from the rest → unavailable', () => {
    const v = statusVerdict([A, B, C], [dead(A), dead(B), other(C)]);
    expect(v.kind).toBe('unavailable');
  });

  // 400 is classified `other` by the callers; it must never reach `dead`,
  // because `dead` is what authorizes a paid re-post.
  it('a 400 (classified `other`) can never produce dead', () => {
    const v = statusVerdict([A, B], [dead(A), other(B)]);
    expect(v.kind).toBe('unavailable');
  });

  it('a malformed 200 is `other`: not alive, and it blocks dead', () => {
    expect(statusVerdict([A, B], [other(A), other(B)]).kind).toBe('unavailable');
    expect(statusVerdict([A, B], [dead(A), other(B)]).kind).toBe('unavailable');
  });

  it('a single configured origin can never reach dead (MIN_STATUS_ORIGINS)', () => {
    expect(MIN_STATUS_ORIGINS).toBe(2);
    expect(statusVerdict([A], [dead(A)]).kind).toBe('unavailable');
  });

  it('the verdict is invariant to vote order', () => {
    const votes = [ok(A, 30, 1000), dead(B), other(C), other(D), pending(E)];
    const forward = statusVerdict(FIVE, votes);
    const reversed = statusVerdict(FIVE, [...votes].reverse());
    expect(reversed).toEqual(forward);
  });
});

describe('statusVerdict — conservative aggregation of disagreeing 200s', () => {
  it('takes the LOWEST confirmation count', () => {
    const v = statusVerdict([A, B, C], [ok(A, 30, 1000), ok(B, 5, 1200), ok(C, 40, 900)]);
    expect(v).toEqual({ kind: 'confirmed', confirmations: 5, blockHeight: 1200 });
  });

  it('equal confirmations, different heights → the lowest height', () => {
    const v = statusVerdict([A, B], [ok(A, 10, 1200), ok(B, 10, 1100)]);
    expect(v).toEqual({ kind: 'confirmed', confirmations: 10, blockHeight: 1100 });
  });

  it('equal confirmations AND heights → the lexicographically smaller origin', () => {
    // Both carry the same numbers, so the tie-break only has to be TOTAL and
    // stable; asserting the result is deterministic is the point.
    const v = statusVerdict([C, B], [ok(C, 10, 1100), ok(B, 10, 1100)]);
    expect(v).toEqual({ kind: 'confirmed', confirmations: 10, blockHeight: 1100 });
  });
});

describe('statusVerdict — the vote set must describe the configured set exactly', () => {
  it('rejects an INCOMPLETE set (the false-dead trap)', () => {
    // Two 404s out of five configured must never look like a full quorum just
    // because the caller filtered the timeouts away.
    expect(() => statusVerdict(FIVE, [dead(A), dead(B)])).toThrow(StatusVoteSetError);
  });

  it('rejects a foreign origin swapped in at the SAME set size', () => {
    expect(() => statusVerdict([A, B], [dead(A), dead('https://evil.example')]))
      .toThrow(StatusVoteSetError);
  });

  it('rejects a duplicated vote (a repeated origin is not a second witness)', () => {
    expect(() => statusVerdict([A, B], [dead(A), dead(A)])).toThrow(StatusVoteSetError);
  });

  it('rejects a duplicated CONFIGURED origin', () => {
    expect(() => statusVerdict([A, A], [dead(A)])).toThrow(StatusVoteSetError);
  });
});

describe('vocabulary adapter', () => {
  it('maps dead → dropped and leaves the rest alone', () => {
    expect(toTxStatusKind('dead')).toBe('dropped');
    expect(toTxStatusKind('confirmed')).toBe('confirmed');
    expect(toTxStatusKind('pending')).toBe('pending');
    expect(toTxStatusKind('unavailable')).toBe('unavailable');
  });
});

describe('policy id', () => {
  // The id is the attestation; pinning it in a test makes any change to the
  // string a deliberate, visible one — it must move together with the algorithm.
  it('is the code-defined constant, not configuration', () => {
    expect(QUORUM_POLICY_ID).toBe('all-configured-v1');
  });
});
