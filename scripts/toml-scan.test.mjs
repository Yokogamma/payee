import { describe, it, expect } from 'vitest';
import { readTomlString } from './toml-scan.mjs';

describe('readTomlString — the happy shape wrangler.toml actually uses', () => {
  const toml = `
name = "eternal-notes-proxy"

[vars]
ALLOWED_ORIGINS = "https://notes.example"
UPLOADS_ENABLED = "true"

[env.staging]
name = "staging"

[env.staging.vars]
UPLOADS_ENABLED = "false"
`;
  it('reads a key from the root and from nested tables', () => {
    expect(readTomlString(toml, '', 'name').value).toBe('eternal-notes-proxy');
    expect(readTomlString(toml, 'vars', 'UPLOADS_ENABLED').value).toBe('true');
    expect(readTomlString(toml, 'env.staging.vars', 'UPLOADS_ENABLED').value).toBe('false');
  });

  it('reports a missing key or table instead of guessing', () => {
    expect(readTomlString(toml, 'vars', 'NOPE').error).toMatch(/missing NOPE/);
    expect(readTomlString(toml, 'absent', 'X').error).toMatch(/missing table/);
  });
});

// ── The bypasses a substring search allows ────────────────────────────────
describe('hostile inputs', () => {
  it('IGNORES a decoy table hidden in a multi-line string', () => {
    // `indexOf('[vars]')` finds the decoy FIRST and reads "false", while
    // wrangler reads the real table and uploads stay on.
    const toml = `
[define]
NOTE = """
[vars]
UPLOADS_ENABLED = "false"
"""

[vars]
UPLOADS_ENABLED = "true"
`;
    expect(readTomlString(toml, 'vars', 'UPLOADS_ENABLED').value).toBe('true');
  });

  it('ignores a decoy inside a single-quoted multi-line string', () => {
    const toml = `
[define]
NOTE = '''
[vars]
UPLOADS_ENABLED = "false"
'''

[vars]
UPLOADS_ENABLED = "true"
`;
    expect(readTomlString(toml, 'vars', 'UPLOADS_ENABLED').value).toBe('true');
  });

  it('ignores a commented-out table header and a commented key', () => {
    const toml = `
# [vars]
# UPLOADS_ENABLED = "false"

[vars]
UPLOADS_ENABLED = "true"
`;
    expect(readTomlString(toml, 'vars', 'UPLOADS_ENABLED').value).toBe('true');
  });

  // Refusing beats merging: which of the two wrangler honours is not something
  // this scanner should have an opinion about.
  it('REFUSES a duplicated table rather than picking one', () => {
    const toml = `
[vars]
UPLOADS_ENABLED = "true"

[vars]
UPLOADS_ENABLED = "false"
`;
    expect(readTomlString(toml, 'vars', 'UPLOADS_ENABLED').error).toMatch(/declared 2 times/);
  });

  it('REFUSES a duplicated key inside one table', () => {
    const toml = `
[vars]
UPLOADS_ENABLED = "true"
UPLOADS_ENABLED = "false"
`;
    expect(readTomlString(toml, 'vars', 'UPLOADS_ENABLED').error).toMatch(/declared twice/);
  });

  it('REFUSES a non-string value rather than coercing it', () => {
    expect(readTomlString('[vars]\nUPLOADS_ENABLED = true\n', 'vars', 'UPLOADS_ENABLED').error)
      .toMatch(/not a basic string/);
    expect(readTomlString('[vars]\nX = ["a"]\n', 'vars', 'X').error).toMatch(/not a basic string/);
  });

  it('REFUSES an unterminated multi-line string', () => {
    expect(() => readTomlString('[define]\nX = """\nopen forever\n', 'vars', 'Y'))
      .toThrow(/unterminated/);
  });

  it('does not confuse a table header appearing INSIDE a value', () => {
    const toml = `
[vars]
NOTE = "see [vars] for details"
UPLOADS_ENABLED = "true"
`;
    expect(readTomlString(toml, 'vars', 'UPLOADS_ENABLED').value).toBe('true');
  });

  it('tolerates a trailing comment after a value', () => {
    expect(readTomlString('[vars]\nX = "y" # why\n', 'vars', 'X').value).toBe('y');
  });

  it('handles [[array.tables]] headers without treating them as the same table', () => {
    const toml = `
[[kv_namespaces]]
binding = "A"

[vars]
X = "y"
`;
    expect(readTomlString(toml, 'vars', 'X').value).toBe('y');
  });
});
