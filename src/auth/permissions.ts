/**
 * Authorization preHandlers.
 *
 * Backend checks are authoritative. Frontend route guards are usability only.
 */
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { LocalAuthProvider } from './local-provider.js';
import { hasAnyRole, type RoleCode } from './principal.js';

export const SESSION_COOKIE_NAME = 'dskt_session';

declare module 'fastify' {
  interface FastifyRequest {
    principal?: import('./principal.js').RequestPrincipal;
  }
}

export async function resolvePrincipalFromCookie(
  request: FastifyRequest,
  provider: LocalAuthProvider,
): Promise<import('./principal.js').RequestPrincipal | null> {
  const token = request.cookies[SESSION_COOKIE_NAME];
  if (!token) {
    return null;
  }
  return provider.fromToken(token);
}

/** Require a valid authenticated principal. Sends 401 and clears the cookie on failure. */
export function requirePrincipal(provider: LocalAuthProvider): preHandlerHookHandler {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = await resolvePrincipalFromCookie(request, provider);
    if (!principal) {
      reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
      return reply.code(401).send({ error: 'unauthorized' });
    }
    request.principal = principal;
  };
}

/** Require the principal to hold at least one of the listed roles. Sends 403 otherwise. */
export function requireAnyRole(...allowed: RoleCode[]): preHandlerHookHandler {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = request.principal;
    if (!principal) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    if (!hasAnyRole(principal, allowed)) {
      return reply.code(403).send({ error: 'forbidden' });
    }
  };
}
