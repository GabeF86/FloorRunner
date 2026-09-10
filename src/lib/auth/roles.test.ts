import { describe, it, expect } from 'vitest';
import { resolveSessionRole, ADMIN_ROLE, PROVIDER_ROLE } from './roles';

describe('resolveSessionRole', () => {
  it('is anonymous with no user', () => {
    expect(resolveSessionRole(null, ['admin'])).toBe('anonymous');
    expect(resolveSessionRole(undefined, ['admin'])).toBe('anonymous');
    expect(resolveSessionRole('', ['admin'])).toBe('anonymous');
  });

  it('is admin when the admin role is held', () => {
    expect(resolveSessionRole('u1', [ADMIN_ROLE])).toBe('admin');
  });

  it('is provider when only the provider role is held', () => {
    expect(resolveSessionRole('u1', [PROVIDER_ROLE])).toBe('provider');
  });

  it('prefers admin when both are held', () => {
    expect(resolveSessionRole('u1', [PROVIDER_ROLE, ADMIN_ROLE])).toBe('admin');
    expect(resolveSessionRole('u1', [ADMIN_ROLE, PROVIDER_ROLE])).toBe('admin');
  });

  it('is anonymous for a signed-in user holding NO role', () => {
    // The half-provisioned case: an auth user exists but nothing granted it a
    // role. It must not inherit provider access by virtue of being signed in —
    // a session that resolves to nobody gets nothing.
    expect(resolveSessionRole('u1', [])).toBe('anonymous');
  });

  it('is anonymous for a user holding only an unrecognised role', () => {
    expect(resolveSessionRole('u1', ['superuser', 'wat'])).toBe('anonymous');
  });

  it('ignores unrecognised roles alongside a real one', () => {
    expect(resolveSessionRole('u1', ['wat', PROVIDER_ROLE])).toBe('provider');
  });

  it('does not match a role name by case or prefix', () => {
    // 'Admin' and 'administrator' are not the admin role.
    expect(resolveSessionRole('u1', ['Admin'])).toBe('anonymous');
    expect(resolveSessionRole('u1', ['administrator'])).toBe('anonymous');
    expect(resolveSessionRole('u1', ['adm'])).toBe('anonymous');
  });

  it('tolerates a null role list', () => {
    expect(resolveSessionRole('u1', null)).toBe('anonymous');
  });

  it('tolerates non-string members', () => {
    expect(resolveSessionRole('u1', [null, undefined, 7, ADMIN_ROLE] as unknown as string[]))
      .toBe('admin');
  });
});
