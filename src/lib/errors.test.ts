import { describe, it, expect } from 'vitest';
import { userFacingUploadError, userFacingRegistrationError } from './errors';

describe('userFacingUploadError (RU dictionary, L13)', () => {
  it('detects clock skew from the server text regardless of kind', () => {
    const msg = userFacingUploadError('error', 'HTTP 401: Timestamp expired or device clock skew (allowed drift: 5 min) — check the device date/time');
    expect(msg).toMatch(/Часы устройства/);
    expect(userFacingUploadError('unavailable', 'clock skew detected')).toMatch(/Часы устройства/);
  });

  it('maps transport kinds to Russian user-facing texts', () => {
    expect(userFacingUploadError('rate_limited')).toMatch(/Лимит/);
    expect(userFacingUploadError('not_registered')).toMatch(/invite/);
    expect(userFacingUploadError('unavailable')).toMatch(/недоступен/);
    expect(userFacingUploadError('anything-else')).toMatch(/Не удалось/);
  });
});

describe('userFacingRegistrationError (invite/registration RU mapper)', () => {
  it('maps server texts to actionable Russian messages', () => {
    expect(userFacingRegistrationError('Registration failed: Invalid or used invite code'))
      .toMatch(/Неверный или уже использованный/);
    expect(userFacingRegistrationError('Too many attempts. Try again later.'))
      .toMatch(/Слишком много попыток/);
    expect(userFacingRegistrationError('Timestamp expired or device clock skew (allowed drift: 5 min) — check the device date/time'))
      .toMatch(/Часы устройства/);
    expect(userFacingRegistrationError('HTTP 500 whatever')).toMatch(/Не удалось активировать/);
  });
});
