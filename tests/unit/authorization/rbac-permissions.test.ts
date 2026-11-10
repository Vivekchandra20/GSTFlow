import { describe, it, expect } from 'vitest';
import {
  hasPermission,
  getRolePermissions,
  isRoleHigherOrEqual,
  isRoleStrictlyHigher,
  MembershipRole,
  Permission
} from '../../../src/modules/authorization/permissions.js';

describe('RBAC & Permissions (Unit Suite)', () => {
  describe('Role Hierarchy', () => {
    it('correctly ranks OWNER strictly higher than ADMIN, MEMBER, VIEWER', () => {
      expect(isRoleStrictlyHigher('OWNER', 'ADMIN')).toBe(true);
      expect(isRoleStrictlyHigher('OWNER', 'MEMBER')).toBe(true);
      expect(isRoleStrictlyHigher('OWNER', 'VIEWER')).toBe(true);
      expect(isRoleStrictlyHigher('OWNER', 'OWNER')).toBe(false);
    });

    it('correctly ranks ADMIN strictly higher than MEMBER and VIEWER, but not OWNER', () => {
      expect(isRoleStrictlyHigher('ADMIN', 'MEMBER')).toBe(true);
      expect(isRoleStrictlyHigher('ADMIN', 'VIEWER')).toBe(true);
      expect(isRoleStrictlyHigher('ADMIN', 'OWNER')).toBe(false);
      expect(isRoleStrictlyHigher('ADMIN', 'ADMIN')).toBe(false);
    });

    it('evaluates higher-or-equal comparisons accurately', () => {
      expect(isRoleHigherOrEqual('ADMIN', 'ADMIN')).toBe(true);
      expect(isRoleHigherOrEqual('ADMIN', 'MEMBER')).toBe(true);
      expect(isRoleHigherOrEqual('MEMBER', 'ADMIN')).toBe(false);
    });
  });

  describe('Permissions Mapping', () => {
    it('grants OWNER all organization, member, and GST operational permissions', () => {
      const ownerPerms = getRolePermissions('OWNER');
      expect(hasPermission('OWNER', 'organization:delete')).toBe(true);
      expect(hasPermission('OWNER', 'organization:update')).toBe(true);
      expect(hasPermission('OWNER', 'members:remove')).toBe(true);
      expect(hasPermission('OWNER', 'gst:write')).toBe(true);
      expect(hasPermission('OWNER', 'gstin:create')).toBe(true);
      expect(hasPermission('OWNER', 'gstin:deactivate')).toBe(true);
      expect(hasPermission('OWNER', 'batches:process')).toBe(true);
      expect(hasPermission('OWNER', 'import:create')).toBe(true);
      expect(hasPermission('OWNER', 'import:read')).toBe(true);
      expect(hasPermission('OWNER', 'import:cancel')).toBe(true);
      expect(ownerPerms.length).toBe(20);
    });

    it('grants ADMIN operational and administrative permissions, but denies organization:delete', () => {
      expect(hasPermission('ADMIN', 'organization:update')).toBe(true);
      expect(hasPermission('ADMIN', 'members:invite')).toBe(true);
      expect(hasPermission('ADMIN', 'members:update')).toBe(true);
      expect(hasPermission('ADMIN', 'gst:write')).toBe(true);
      expect(hasPermission('ADMIN', 'gstin:create')).toBe(true);
      expect(hasPermission('ADMIN', 'gstin:deactivate')).toBe(true);
      expect(hasPermission('ADMIN', 'import:create')).toBe(true);
      expect(hasPermission('ADMIN', 'import:read')).toBe(true);
      expect(hasPermission('ADMIN', 'import:cancel')).toBe(true);
      expect(hasPermission('ADMIN', 'organization:delete')).toBe(false);
    });

    it('grants MEMBER operational GST access, but denies administrative member management', () => {
      expect(hasPermission('MEMBER', 'gst:read')).toBe(true);
      expect(hasPermission('MEMBER', 'gst:write')).toBe(true);
      expect(hasPermission('MEMBER', 'gstin:read')).toBe(true);
      expect(hasPermission('MEMBER', 'gstin:create')).toBe(false);
      expect(hasPermission('MEMBER', 'gstin:update')).toBe(false);
      expect(hasPermission('MEMBER', 'gstin:deactivate')).toBe(false);
      expect(hasPermission('MEMBER', 'batches:process')).toBe(true);
      expect(hasPermission('MEMBER', 'import:create')).toBe(true);
      expect(hasPermission('MEMBER', 'import:read')).toBe(true);
      expect(hasPermission('MEMBER', 'import:cancel')).toBe(false);
      expect(hasPermission('MEMBER', 'members:read')).toBe(true);
      expect(hasPermission('MEMBER', 'members:invite')).toBe(false);
      expect(hasPermission('MEMBER', 'members:update')).toBe(false);
      expect(hasPermission('MEMBER', 'organization:update')).toBe(false);
    });

    it('restricts VIEWER strictly to read-only operations', () => {
      expect(hasPermission('VIEWER', 'organization:read')).toBe(true);
      expect(hasPermission('VIEWER', 'members:read')).toBe(true);
      expect(hasPermission('VIEWER', 'gst:read')).toBe(true);
      expect(hasPermission('VIEWER', 'gstin:read')).toBe(true);
      expect(hasPermission('VIEWER', 'gstin:create')).toBe(false);
      expect(hasPermission('VIEWER', 'gstin:update')).toBe(false);
      expect(hasPermission('VIEWER', 'gst:write')).toBe(false);
      expect(hasPermission('VIEWER', 'batches:process')).toBe(false);
      expect(hasPermission('VIEWER', 'invoices:write')).toBe(false);
      expect(hasPermission('VIEWER', 'import:read')).toBe(true);
      expect(hasPermission('VIEWER', 'import:create')).toBe(false);
      expect(hasPermission('VIEWER', 'import:cancel')).toBe(false);
    });
  });
});
