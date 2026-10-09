import { describe, expect, it } from 'vitest';
import { navigationForRoles } from '../src/auth/principal.js';

describe('navigationForRoles', () => {
  it('derives the union of workspace keys from active roles', () => {
    expect(navigationForRoles(['FACILITIES_ADMIN'])).toEqual(['facilities']);
    expect(navigationForRoles(['WORKPLACE_PLANNER'])).toEqual(['workplace']);
    expect(navigationForRoles(['VIEWER'])).toEqual(['viewer']);
    expect(navigationForRoles(['SYSTEM_ADMIN'])).toEqual(['access_admin']);
    expect(navigationForRoles(['FACILITIES_ADMIN', 'VIEWER', 'SYSTEM_ADMIN'])).toEqual([
      'facilities',
      'viewer',
      'access_admin',
    ]);
    expect(navigationForRoles([])).toEqual([]);
  });
});
