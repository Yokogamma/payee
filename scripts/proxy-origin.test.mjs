import { describe, it, expect } from 'vitest';
import { resolveProxyOrigin } from './proxy-origin.mjs';

// Build-time CSP origin validation: production/CI builds must never accept an
// http proxy — a mistyped production secret would ship a broken client.

describe('resolveProxyOrigin', () => {
  it('accepts a bare https origin (trailing slash tolerated, origin returned)', () => {
    expect(resolveProxyOrigin('https://proxy.example.workers.dev', { ci: true }))
      .toBe('https://proxy.example.workers.dev');
    expect(resolveProxyOrigin('https://proxy.example.workers.dev/', { ci: true }))
      .toBe('https://proxy.example.workers.dev');
  });

  it('rejects empty/invalid URLs', () => {
    expect(() => resolveProxyOrigin('', { ci: false })).toThrow();
    expect(() => resolveProxyOrigin('not a url', { ci: true })).toThrow();
  });

  it('rejects a URL with path/query/hash — the client concatenates onto the origin', () => {
    expect(() => resolveProxyOrigin('https://proxy.example.com/path', { ci: true })).toThrow(/bare origin/);
    expect(() => resolveProxyOrigin('https://proxy.example.com/?q=1', { ci: true })).toThrow(/bare origin/);
    expect(() => resolveProxyOrigin('https://proxy.example.com/#x', { ci: true })).toThrow(/bare origin/);
  });

  it('rejects embedded credentials', () => {
    expect(() => resolveProxyOrigin('https://user:pass@proxy.example.com', { ci: true })).toThrow(/credentials/);
  });

  it('rejects non-http(s) protocols even for localhost', () => {
    expect(() => resolveProxyOrigin('ftp://localhost:21', { ci: false })).toThrow(/https/);
    expect(() => resolveProxyOrigin('ws://localhost:8787', { ci: false })).toThrow(/https/);
  });

  it('rejects non-localhost http regardless of mode', () => {
    expect(() => resolveProxyOrigin('http://proxy.example.com', { ci: false })).toThrow(/https/);
    expect(() => resolveProxyOrigin('http://proxy.example.com', { ci: true })).toThrow(/https/);
  });

  it('allows http://localhost for local dev builds only', () => {
    expect(resolveProxyOrigin('http://localhost:8787', { ci: false })).toBe('http://localhost:8787');
    expect(resolveProxyOrigin('http://127.0.0.1:8787', { ci: false })).toBe('http://127.0.0.1:8787');
  });

  it('REJECTS http://localhost in CI/production builds', () => {
    expect(() => resolveProxyOrigin('http://localhost:8787', { ci: true })).toThrow(/not allowed in CI/);
  });

  it('CI can opt in explicitly via allowHttp (deliberate non-production build)', () => {
    expect(resolveProxyOrigin('http://localhost:8787', { ci: true, allowHttp: true }))
      .toBe('http://localhost:8787');
  });
});
