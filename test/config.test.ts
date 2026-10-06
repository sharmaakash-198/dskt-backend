import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ConfigurationError, loadConfig } from '../src/config.js';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('loadConfig', () => {
  it('rejects a missing database URL without echoing a secret', () => {
    expect(() =>
      loadConfig({
        CORS_ORIGIN: 'http://localhost:8080',
      }),
    ).toThrow(ConfigurationError);

    try {
      loadConfig({
        DATABASE_URL: 'postgres://dskt:super-secret-password@localhost:5432/dskt',
        CORS_ORIGIN: '',
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as Error).message).not.toContain('super-secret-password');
    }
  });

  it('accepts a local postgres URL', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://dskt:dskt-local-only@localhost:5432/dskt',
      CORS_ORIGIN: 'http://localhost:8080',
    });
    expect(config.PORT).toBe(3000);
    expect(config.DATABASE_URL).toContain('localhost:5432/dskt');
  });
});

describe('startup', () => {
  it('exits clearly when required configuration is missing', () => {
    const result = spawnSync('npx', ['tsx', 'src/server.ts'], {
      cwd: backendRoot,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Invalid configuration');
    expect(result.stderr).toContain('DATABASE_URL');
  });
});
