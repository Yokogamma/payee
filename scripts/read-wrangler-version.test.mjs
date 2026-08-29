import { describe, it, expect } from 'vitest';
import { parseWranglerOutput } from './read-wrangler-version.mjs';
import { WORKER_NAME } from '../worker/scripts/smoke-target.mjs';

const line = (o) => JSON.stringify(o);

describe('parseWranglerOutput — NDJSON, not a single JSON document', () => {
  it('reads the version id out of a deploy record among other lines', () => {
    const text = [
      line({ type: 'wrangler-session', version: 1 }),
      line({ type: 'deploy', worker_name: WORKER_NAME, version_id: 'v-123' }),
      '',
    ].join('\n');
    expect(parseWranglerOutput(text)).toEqual({ workerName: WORKER_NAME, versionId: 'v-123' });
  });

  it('accepts the camelCase spelling too', () => {
    expect(parseWranglerOutput(line({ type: 'deployment', workerName: WORKER_NAME, versionId: 'v-9' })))
      .toEqual({ workerName: WORKER_NAME, versionId: 'v-9' });
  });

  // Anything ambiguous is an error: "probably fine" here means we cannot say
  // what is actually running, which is the one thing this exists to establish.
  it('fails on no deploy record', () => {
    expect(parseWranglerOutput(line({ type: 'wrangler-session' })).error).toMatch(/no deploy record/);
    expect(parseWranglerOutput('').error).toMatch(/no deploy record/);
  });

  it('fails on MORE than one deploy record', () => {
    const text = [
      line({ type: 'deploy', version_id: 'a' }),
      line({ type: 'deploy', version_id: 'b' }),
    ].join('\n');
    expect(parseWranglerOutput(text).error).toMatch(/2 deploy records/);
  });

  it('fails on a malformed line rather than skipping it', () => {
    const text = [line({ type: 'deploy', version_id: 'a' }), 'not json'].join('\n');
    expect(parseWranglerOutput(text).error).toMatch(/not JSON/);
  });

  it('fails when the deploy record carries no version id', () => {
    expect(parseWranglerOutput(line({ type: 'deploy', worker_name: 'w' })).error)
      .toMatch(/no version id/);
  });
});

describe('the deploy target is verified, not merely reported', () => {
  it('rejects a deploy that landed on a DIFFERENT worker', () => {
    const text = line({ type: 'deploy', worker_name: 'someone-elses-worker', version_id: 'v-1' });
    expect(parseWranglerOutput(text).error).toMatch(/landed on worker "someone-elses-worker"/);
  });

  it('accepts the pinned worker name', () => {
    const text = line({ type: 'deploy', worker_name: WORKER_NAME, version_id: 'v-1' });
    expect(parseWranglerOutput(text)).toEqual({ workerName: WORKER_NAME, versionId: 'v-1' });
  });

  // A record carrying a version id but not typed as a deploy is not evidence of
  // one — a preview upload would otherwise stand in for the deployment.
  it('ignores a non-deploy record even if it has a version id', () => {
    const text = line({ type: 'version-upload', version_id: 'v-preview' });
    expect(parseWranglerOutput(text).error).toMatch(/no deploy record/);
  });
});
