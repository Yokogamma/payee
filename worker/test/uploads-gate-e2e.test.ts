import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import * as ed from '@noble/ed25519';
import worker from '../src/index';
import { setupOutboundMock, b64, sha256 } from './helpers/outbound-mock';

// §1.9: глобальный аварийный рубильник UPLOADS_ENABLED и машинный код обеих
// веток «Invalid recovery token». Direct-dispatch (env-override), тот же
// паттерн, что v3-gate-e2e.test.ts.
//
// Почему отдельный от V3/V4: те гейты срабатывают только на своей declared
// version, а v1/v2 (включая переотправку старых заметок) проходили весь путь
// до платного POST. Аварийный рычаг обязан останавливать ВСЁ.

const ALLOWLIST = (env as unknown as { ALLOWLIST: KVNamespace }).ALLOWLIST;

type WorkerEnv = Parameters<typeof worker.fetch>[1];
const baseEnv = env as unknown as WorkerEnv;

setupOutboundMock(); // ни одного маршрута: любой Arweave-вызов упал бы как 502

const C = 'AAAAAAAAAAAAAAAAAAAAAA=='; // 16 bytes: the GCM tag floor
const IV = 'AAAAAAAAAAAAAAAA';

function uuidV8(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x80;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

async function makeIdentity() {
  const priv = ed.utils.randomSecretKey();
  const pub = await ed.getPublicKeyAsync(priv);
  const pkB64 = b64(pub);
  const ownerHash = b64(await sha256(pub));
  await ALLOWLIST.put(`pk:${pkB64}`, JSON.stringify({ status: 'allowed' }));
  return { priv, pkB64, ownerHash };
}

type Identity = Awaited<ReturnType<typeof makeIdentity>>;

async function signedUpload(
  id: Identity,
  noteId: string,
  ip: string,
  version: '1' | '3',
  extra: Record<string, unknown> = {},
): Promise<Request> {
  const tags = [
    { name: 'App-Name', value: 'EternalNotes' },
    { name: 'App-Version', value: version },
    { name: 'Content-Type', value: 'application/json' },
    { name: 'Owner-Hash', value: id.ownerHash },
    ...(version === '1' ? [{ name: 'Timestamp', value: '1700000000000' }] : []),
    { name: 'Note-Id', value: noteId },
  ];
  const dataObj = version === '1'
    ? { id: noteId, c: C, iv: IV, t: 1700000000000 }
    : { id: noteId, c: C, iv: IV };
  const body = JSON.stringify({
    data: JSON.stringify(dataObj),
    tags,
    ownerHash: id.ownerHash,
    timestamp: Date.now(),
    ...extra,
  });
  const sig = b64(await ed.signAsync(await sha256(new TextEncoder().encode(body)), id.priv));
  return new Request('https://proxy.example.com/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Public-Key': id.pkB64, 'X-Signature': sig, 'CF-Connecting-IP': ip },
    body,
  });
}

const nextIp = () => `ug-${crypto.randomUUID().slice(0, 8)}`;

describe('/health: глобальный флаг uploads', () => {
  it('отражает состояние рубильника', async () => {
    const rOn = await worker.fetch(new Request('https://proxy.example.com/health'), baseEnv);
    const bOn = await rOn.json() as { ok: boolean; uploads: boolean };
    expect(bOn.ok).toBe(true);
    expect(bOn.uploads).toBe(true); // wrangler.toml vars: UPLOADS_ENABLED="true"

    const rOff = await worker.fetch(
      new Request('https://proxy.example.com/health'),
      { ...baseEnv, UPLOADS_ENABLED: 'false' },
    );
    expect(((await rOff.json()) as { uploads: boolean }).uploads).toBe(false);
  });
});

describe('глобальный рубильник UPLOADS_ENABLED', () => {
  const gateOff = { ...baseEnv, UPLOADS_ENABLED: 'false' };

  it.each(['1', '3'] as const)(
    'валидная подписанная v%s-загрузка получает 503 {code:uploads_disabled} — весь поток, не только v3/v4',
    async version => {
      const id = await makeIdentity();
      const r = await worker.fetch(await signedUpload(id, uuidV8(), nextIp(), version), gateOff);
      expect(r.status).toBe(503);
      expect(r.headers.get('Content-Type')).toBe('application/json');
      expect(((await r.json()) as { code: string }).code).toBe('uploads_disabled');
    },
  );

  it('срабатывает раньше любой другой валидации: запрос без auth-заголовков — 503, а не 401', async () => {
    const r = await worker.fetch(
      new Request('https://proxy.example.com/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': nextIp() },
        body: '{}',
      }),
      gateOff,
    );
    expect(r.status).toBe(503);
    expect(((await r.json()) as { code: string }).code).toBe('uploads_disabled');
  });

  it('fail CLOSED: отсутствующее или мусорное значение = стоп', async () => {
    const id = await makeIdentity();
    const missingEnv = { ...baseEnv } as Record<string, unknown>;
    delete missingEnv.UPLOADS_ENABLED;
    const rMissing = await worker.fetch(
      await signedUpload(id, uuidV8(), nextIp(), '3'), missingEnv as WorkerEnv,
    );
    expect(rMissing.status).toBe(503);
    expect(((await rMissing.json()) as { code: string }).code).toBe('uploads_disabled');

    const rGarbage = await worker.fetch(
      await signedUpload(id, uuidV8(), nextIp(), '3'),
      { ...baseEnv, UPLOADS_ENABLED: 'yes' },
    );
    expect(rGarbage.status).toBe(503);
  });

  it('при "true" гейт открыт: тот же запрос без auth-заголовков идёт дальше и получает 401', async () => {
    const r = await worker.fetch(
      new Request('https://proxy.example.com/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': nextIp() },
        body: '{}',
      }),
      baseEnv,
    );
    expect(r.status).toBe(401); // Missing auth headers — значит, рубильник пропустил
  });
});

describe('обе ветки «Invalid recovery token» — HTTP 400 + одинаковый машинный code', () => {
  it('ветка 1: present-but-unusable hint (recovery без recheck) — 400 {code:recovery_invalid}', async () => {
    const id = await makeIdentity();
    const r = await worker.fetch(
      await signedUpload(id, uuidV8(), nextIp(), '3', {
        recovery: { txId: 'x'.repeat(43), postedAt: Date.now(), token: 'garbage' },
        // recheck отсутствует → hint непригоден → fail closed
      }),
      baseEnv,
    );
    expect(r.status).toBe(400);
    expect(r.headers.get('Content-Type')).toBe('application/json');
    const body = await r.json() as { code: string; error: string };
    expect(body.code).toBe('recovery_invalid');
    expect(body.error).toBe('Invalid recovery token');
  });

  it('ветка 2: невалидный HMAC при recheck — 400 с ТЕМ ЖЕ code', async () => {
    const id = await makeIdentity();
    const r = await worker.fetch(
      await signedUpload(id, uuidV8(), nextIp(), '3', {
        recheck: true,
        recovery: { txId: 'x'.repeat(43), postedAt: Date.now(), token: 'not-a-valid-hmac' },
      }),
      baseEnv,
    );
    expect(r.status).toBe(400);
    const body = await r.json() as { code: string };
    expect(body.code).toBe('recovery_invalid');
  });

  it('форма остальных ошибок API не изменилась: 401 без auth-заголовков — plain text', async () => {
    const r = await worker.fetch(
      new Request('https://proxy.example.com/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': nextIp() },
        body: '{}',
      }),
      baseEnv,
    );
    expect(r.status).toBe(401);
    expect(r.headers.get('Content-Type')).not.toBe('application/json');
    expect(await r.text()).toBe('Missing auth headers');
  });
});
