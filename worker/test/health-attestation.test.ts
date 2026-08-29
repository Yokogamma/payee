import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';
import { QUORUM_POLICY_ID } from '../../src/lib/status-quorum';
import { serializeStatusOrigins } from '../../src/lib/gateways-parse';

// `/health` is not only a diagnostic: the client uses it to decide whether a
// PERSISTED upload pause may be lifted, and the deploy smoke uses it to decide
// whether the release that just went out is the one that was gated. Both
// decisions are only as good as the freshness and the identity of the answer.

type WorkerEnv = Parameters<typeof worker.fetch>[1];
const baseEnv = env as unknown as WorkerEnv;

const health = (query = '', overrides: Partial<WorkerEnv> = {}) =>
  worker.fetch(new Request(`https://proxy.example.com/health${query}`), { ...baseEnv, ...overrides });

/** The hash the deploy smoke recomputes from wrangler.toml, done independently
 *  here so a change to the worker's own helper cannot silently redefine it. */
async function expectedHash(origins: string[]): Promise<string> {
  const bytes = new TextEncoder().encode(serializeStatusOrigins(origins));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

describe('/health — quorum attestation', () => {
  it('reports the policy id from the CODE that implements the algorithm', async () => {
    const body = await (await health()).json() as { statusQuorumPolicy: string };
    expect(body.statusQuorumPolicy).toBe(QUORUM_POLICY_ID);
  });

  it('reports the configured gateway count and a hash of the sorted set', async () => {
    const body = await (await health()).json() as {
      statusGatewaysCount: number; statusGatewaysHash: string;
    };
    expect(body.statusGatewaysCount).toBe(2);
    expect(body.statusGatewaysHash)
      .toBe(await expectedHash(['https://arweave.net', 'https://g2.test']));
  });

  // The status order is NOT normative, so a reordered configuration must not
  // change the value the smoke compares — otherwise a harmless edit reads as a
  // tampered release.
  it('the hash is invariant to the order of the configured list', async () => {
    const a = await (await health('', { STATUS_GATEWAYS: 'https://a.test,https://b.test' })).json() as { statusGatewaysHash: string };
    const b = await (await health('', { STATUS_GATEWAYS: 'https://b.test,https://a.test' })).json() as { statusGatewaysHash: string };
    expect(a.statusGatewaysHash).toBe(b.statusGatewaysHash);
  });

  it('a different SET does change the hash', async () => {
    const a = await (await health('', { STATUS_GATEWAYS: 'https://a.test,https://b.test' })).json() as { statusGatewaysHash: string };
    const b = await (await health('', { STATUS_GATEWAYS: 'https://a.test,https://c.test' })).json() as { statusGatewaysHash: string };
    expect(a.statusGatewaysHash).not.toBe(b.statusGatewaysHash);
  });
});

describe('/health — release identity', () => {
  it('reports the deployed SHA and the ACTIVE worker version id', async () => {
    const body = await (await health('', {
      RELEASE_SHA: 'a'.repeat(40),
      CF_VERSION_METADATA: { id: 'version-123' },
    })).json() as { releaseSha: string | null; workerVersionId: string | null };
    expect(body.releaseSha).toBe('a'.repeat(40));
    // The SHA alone cannot distinguish a re-deploy of the same commit; the
    // version id can, which is why the smoke checks both.
    expect(body.workerVersionId).toBe('version-123');
  });

  it('reports null rather than inventing values when unset', async () => {
    const body = await (await health('', { RELEASE_SHA: undefined, CF_VERSION_METADATA: undefined })).json() as {
      releaseSha: string | null; workerVersionId: string | null;
    };
    expect(body.releaseSha).toBeNull();
    expect(body.workerVersionId).toBeNull();
  });
});

describe('/health — freshness', () => {
  it('always answers no-store', async () => {
    expect((await health()).headers.get('Cache-Control')).toBe('no-store');
  });

  it('echoes a well-formed nonce verbatim', async () => {
    const body = await (await health('?nonce=0123456789abcdef')).json() as { nonce?: string };
    expect(body.nonce).toBe('0123456789abcdef');
  });

  // Backwards compatible on purpose: a human with curl, and every client built
  // before this release, sends no nonce and still gets the diagnostic body.
  it('omits the field entirely when no nonce is asked for', async () => {
    const body = await (await health()).json() as { nonce?: string };
    expect(body.nonce).toBeUndefined();
  });

  it('rejects a malformed nonce instead of echoing something else', async () => {
    for (const bad of ['short', 'ZZZZZZZZZZZZZZZZ', '0123456789ABCDEF', '0123456789abcdef0']) {
      expect((await health(`?nonce=${bad}`)).status).toBe(400);
    }
  });
});

describe('/health — the capability fields the client gates on', () => {
  it('still reports ok, versions and the three upload switches', async () => {
    const body = await (await health()).json() as {
      ok: boolean; versions: string[]; uploads: boolean; v3Uploads: boolean; v4Uploads: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.versions).toEqual(['1', '2', '3', '4']);
    expect(typeof body.uploads).toBe('boolean');
    expect(typeof body.v3Uploads).toBe('boolean');
    expect(typeof body.v4Uploads).toBe('boolean');
  });

  // The global switch is what an emergency lineage relies on: a build that
  // refuses every upload must be readable as such by the client.
  it('reports uploads:false when the global kill switch is off', async () => {
    const body = await (await health('', { UPLOADS_ENABLED: 'false' })).json() as { uploads: boolean };
    expect(body.uploads).toBe(false);
  });
});
