import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ConfigurationError, loadConfig } from '../src/config.js';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const BASE_ENV = {
  DATABASE_URL: 'postgres://dskt:dskt-local-only@localhost:5432/dskt',
  CORS_ORIGIN: 'http://localhost:8080',
  SESSION_SECRET: 'test-secret-that-is-at-least-32-characters-long',
};

describe('loadConfig', () => {
  it('rejects a missing database URL without echoing a secret', () => {
    expect(() =>
      loadConfig({
        CORS_ORIGIN: 'http://localhost:8080',
        SESSION_SECRET: BASE_ENV.SESSION_SECRET,
      }),
    ).toThrow(ConfigurationError);

    try {
      loadConfig({
        DATABASE_URL: 'postgres://dskt:super-secret-password@localhost:5432/dskt',
        CORS_ORIGIN: '',
        SESSION_SECRET: BASE_ENV.SESSION_SECRET,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as Error).message).not.toContain('super-secret-password');
    }
  });

  it('rejects a SESSION_SECRET shorter than 32 characters', () => {
    expect(() => loadConfig({ ...BASE_ENV, SESSION_SECRET: 'short' })).toThrow(ConfigurationError);
  });

  it('accepts a local postgres URL with a valid SESSION_SECRET', () => {
    const config = loadConfig(BASE_ENV);
    expect(config.PORT).toBe(3000);
    expect(config.DATABASE_URL).toContain('localhost:5432/dskt');
    expect(config.AUTH_ENV).toBe('local');
    expect(config.SESSION_TTL_SECONDS).toBe(28800);
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

describe('LocalAuthProvider environment guard', () => {
  it('refuses to instantiate when AUTH_ENV is not explicitly local', async () => {
    const { LocalAuthProvider } = await import('../src/auth/local-provider.js');
    const invalidConfig = { ...loadConfig(BASE_ENV), AUTH_ENV: 'entra' as unknown as 'local' };
    expect(() => new LocalAuthProvider({} as never, invalidConfig)).toThrow(
      'LocalAuthProvider may only be instantiated when AUTH_ENV is "local".',
    );
  });
});
