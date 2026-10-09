/**
 * Provider-neutral request principal and role helpers.
 *
 * Domain modules consume RequestPrincipal only. They must not branch on
 * LOCAL versus ENTRA identity.
 */

export const ROLE_CODES = [
  'SYSTEM_ADMIN',
  'FACILITIES_ADMIN',
  'WORKPLACE_PLANNER',
  'VIEWER',
] as const;

export type RoleCode = (typeof ROLE_CODES)[number];

export const AUTH_PROVIDERS = ['LOCAL', 'ENTRA'] as const;
export type AuthProviderKind = (typeof AUTH_PROVIDERS)[number];

/** Stable workspace navigation keys derived from active roles. */
export const NAVIGATION_KEYS = [
  'facilities',
  'workplace',
  'viewer',
  'access_admin',
] as const;

export type NavigationKey = (typeof NAVIGATION_KEYS)[number];

export type RequestPrincipal = {
  appUserId: string;
  provider: AuthProviderKind;
  providerSubject: string;
  roles: RoleCode[];
  email: string;
  displayName: string;
};

export function isRoleCode(value: string): value is RoleCode {
  return (ROLE_CODES as readonly string[]).includes(value);
}

export function isAuthProvider(value: string): value is AuthProviderKind {
  return (AUTH_PROVIDERS as readonly string[]).includes(value);
}

/** Effective navigation is the union of capabilities granted by active roles. */
export function navigationForRoles(roles: readonly RoleCode[]): NavigationKey[] {
  const granted = new Set<NavigationKey>();
  for (const role of roles) {
    switch (role) {
      case 'FACILITIES_ADMIN':
        granted.add('facilities');
        break;
      case 'WORKPLACE_PLANNER':
        granted.add('workplace');
        break;
      case 'VIEWER':
        granted.add('viewer');
        break;
      case 'SYSTEM_ADMIN':
        granted.add('access_admin');
        break;
    }
  }
  return NAVIGATION_KEYS.filter((key) => granted.has(key));
}

export function hasAnyRole(
  principal: RequestPrincipal,
  allowed: readonly RoleCode[],
): boolean {
  return allowed.some((role) => principal.roles.includes(role));
}
