/**
 * Local authentication routes.
 *
 * POST /auth/local/sign-in   — exchange username+password for a session cookie
 * GET  /auth/session          — return the current user, roles, and navigation
 * POST /auth/sign-out         — revoke the session cookie
 *
 * Credentials and cookie values are never logged. Error messages do not
 * reveal whether a username exists.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod/v4';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { LocalAuthProvider } from './local-provider.js';
import { SESSION_COOKIE_NAME } from './permissions.js';
import {
  NAVIGATION_KEYS,
  ROLE_CODES,
  navigationForRoles,
  type RequestPrincipal,
} from './principal.js';

const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  path: '/',
} as const;

const roleCode = z.enum(ROLE_CODES);
const navigationKey = z.enum(NAVIGATION_KEYS);

const sessionUser = z
  .object({
    id: z.string().uuid(),
    email: z.string(),
    displayName: z.string(),
  })
  .meta({ description: 'The currently authenticated application user.' });

const sessionPayload = z
  .object({
    user: sessionUser,
    roles: z.array(roleCode).meta({
      description: 'Active application roles for the user (union of grants).',
    }),
    navigation: z.array(navigationKey).meta({
      description: 'Workspace navigation keys permitted by the active roles.',
    }),
  })
  .meta({ description: 'Authenticated session with roles and permitted navigation.' });

const signOutResponse = z.object({ ok: z.literal(true) }).meta({ description: 'Session revoked.' });

const unauthorizedResponse = z
  .object({ error: z.literal('unauthorized') })
  .meta({ description: 'Not authenticated or session expired/revoked.' });

const badCredentialsResponse = z
  .object({ error: z.literal('invalid_credentials') })
  .meta({ description: 'Credentials were not accepted.' });

const signInBody = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export type AuthRouteOptions = {
  provider: LocalAuthProvider;
  sessionTtlSeconds: number;
};

function toSessionPayload(principal: RequestPrincipal) {
  return {
    user: {
      id: principal.appUserId,
      email: principal.email,
      displayName: principal.displayName,
    },
    roles: principal.roles,
    navigation: navigationForRoles(principal.roles),
  };
}

export const authRoutes: FastifyPluginAsync<AuthRouteOptions> = async (app, opts) => {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.post(
    '/auth/local/sign-in',
    {
      schema: {
        operationId: 'localSignIn',
        tags: ['auth'],
        summary: 'Sign in with local credentials',
        description:
          'Exchanges a username and password for an HttpOnly session cookie. ' +
          'Invalid credentials return a generic error without indicating whether the username exists.',
        security: [],
        body: signInBody,
        response: {
          200: sessionPayload,
          401: badCredentialsResponse,
        },
      },
    },
    async (request, reply) => {
      const { username, password } = request.body;
      const result = await opts.provider.signIn(username, password);
      if (!result) {
        return reply.code(401).send({ error: 'invalid_credentials' });
      }
      reply.setCookie(SESSION_COOKIE_NAME, result.token, {
        ...COOKIE_OPTIONS,
        maxAge: opts.sessionTtlSeconds,
        secure: false, // HTTPS not used in local dev
      });
      return toSessionPayload(result.principal);
    },
  );

  typedApp.get(
    '/auth/session',
    {
      schema: {
        operationId: 'getSession',
        tags: ['auth'],
        summary: 'Get current session',
        description:
          'Returns the authenticated user, effective roles, and permitted navigation from the session cookie, or 401.',
        security: [],
        response: {
          200: sessionPayload,
          401: unauthorizedResponse,
        },
      },
    },
    async (request, reply) => {
      const token = request.cookies[SESSION_COOKIE_NAME];
      if (!token) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      const principal = await opts.provider.fromToken(token);
      if (!principal) {
        reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
        return reply.code(401).send({ error: 'unauthorized' });
      }
      return toSessionPayload(principal);
    },
  );

  typedApp.post(
    '/auth/sign-out',
    {
      schema: {
        operationId: 'signOut',
        tags: ['auth'],
        summary: 'Sign out',
        description: 'Revokes the session cookie.',
        security: [],
        response: {
          200: signOutResponse,
        },
      },
    },
    async (request, reply) => {
      const token = request.cookies[SESSION_COOKIE_NAME];
      if (token) {
        await opts.provider.revoke(token);
      }
      reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
      return { ok: true as const };
    },
  );
};
