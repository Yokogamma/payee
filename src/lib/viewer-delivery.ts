/**
 * Eternal Notes — handing the user the standalone viewer, and saying honestly
 * what that hand-off does and does not guarantee (D19).
 *
 * The app compiles in the SHA-256 of `backup-viewer.html` and checks the bytes
 * it just downloaded against it. That closes exactly one channel — DELIVERY: a
 * response corrupted in transit, a stale copy from a cache, a proxy that
 * rewrote the file. It closes nothing else. An attacker who can rewrite the
 * saved HTML in the user's folder can rewrite anything stored beside it, so
 * AUTHENTICITY rests on the user keeping this checksum somewhere independent
 * — and the UI says that in as many words rather than letting the green tick
 * imply more than it means.
 *
 * Fail-closed on a clean checkout: the constant ships as a placeholder that
 * the build overwrites, and a build that never ran must produce a refusal
 * rather than an unchecked download.
 */

import { BACKUP_VIEWER_SHA256, BACKUP_VIEWER_HASH_IS_PLACEHOLDER } from './backup-viewer-hash';

/** The canonical URL — extensionless. `/backup-viewer.html` also answers, but
 *  only as a redirect target, and it is not the contract (§6). */
export const BACKUP_VIEWER_PATH = 'backup-viewer';

export const BACKUP_VIEWER_FILE_NAME = 'eternal-notes-backup-viewer.html';

/**
 * Refuse a body larger than the viewer could possibly be, BEFORE reading it.
 *
 * The digest check is the wrong place to discover that the response is a
 * gigabyte: by then it is a string in memory. The build enforces a 300 KB
 * ceiling on the artifact (`VIEWER_MAX_BYTES`), so anything past a generous
 * multiple of that is not a viewer whatever its hash would have been — and
 * the case this guards is precisely the one where the origin is not to be
 * trusted.
 */
export const MAX_VIEWER_RESPONSE_BYTES = 1024 * 1024;

export type ViewerDeliveryFailure =
  /** The constant is still the clean-checkout placeholder. */
  | 'not_built'
  /** The request never produced a body — offline, 404, a server error. */
  | 'unavailable'
  /** Bytes arrived and are NOT the ones this build was made against. */
  | 'hash_mismatch';

export class ViewerDeliveryError extends Error {
  readonly reason: ViewerDeliveryFailure;
  constructor(reason: ViewerDeliveryFailure, message: string) {
    super(message);
    this.name = 'ViewerDeliveryError';
    this.reason = reason;
  }
}

export interface ViewerDeliveryDeps {
  fetch: typeof globalThis.fetch;
  sha256Hex(text: string): Promise<string>;
  /** Vite's `import.meta.env.BASE_URL` — always ends in a slash. */
  baseUrl: string;
}

export interface DeliveredViewer {
  text: string;
  fileName: string;
  /** The verified digest, shown so the user can store it independently. */
  sha256: string;
}

export async function fetchBackupViewer(deps: ViewerDeliveryDeps): Promise<DeliveredViewer> {
  if (BACKUP_VIEWER_HASH_IS_PLACEHOLDER) {
    // Refusing is the only honest answer: with no reference digest there is
    // nothing to check against, and a download presented as verified when
    // nothing was verified is worse than no download at all.
    throw new ViewerDeliveryError(
      'not_built',
      'Этот билд собран без просмотрщика — скачивание недоступно.',
    );
  }

  let text: string;
  try {
    const response = await deps.fetch(`${deps.baseUrl}${BACKUP_VIEWER_PATH}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    // Cheap and advisory — a hostile server can lie or omit it — so the real
    // bound is applied to the bytes themselves below. This only avoids
    // downloading what we already know we will refuse.
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_VIEWER_RESPONSE_BYTES) {
      throw new Error(`declared ${declared} bytes`);
    }
    text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_VIEWER_RESPONSE_BYTES) {
      throw new Error('response is larger than any viewer this build could have produced');
    }
  } catch (error) {
    throw new ViewerDeliveryError(
      'unavailable',
      `Не удалось загрузить просмотрщик: ${error instanceof Error ? error.message : 'нет связи'}.`,
    );
  }

  const sha256 = await deps.sha256Hex(text);
  if (sha256 !== BACKUP_VIEWER_SHA256) {
    throw new ViewerDeliveryError(
      'hash_mismatch',
      'Загруженный просмотрщик не совпал с контрольной суммой этого билда — файл не сохранён.',
    );
  }
  return { text, fileName: BACKUP_VIEWER_FILE_NAME, sha256 };
}
