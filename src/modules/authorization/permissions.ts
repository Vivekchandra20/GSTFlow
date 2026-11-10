export type MembershipRole = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';

export type Permission =
  // Organization management
  | 'organization:read'
  | 'organization:update'
  | 'organization:delete'
  // Member management
  | 'members:read'
  | 'members:invite'
  | 'members:update'
  | 'members:remove'
  // GST Operations
  | 'gst:read'
  | 'gst:write'
  | 'gstin:read'
  | 'gstin:create'
  | 'gstin:update'
  | 'gstin:deactivate'
  | 'batches:read'
  | 'batches:process'
  | 'invoices:read'
  | 'invoices:write'
  // Import & File Operations (Phase 4.2.5)
  | 'import:create'
  | 'import:read'
  | 'import:cancel';

export const ALL_PERMISSIONS: Permission[] = [
  'organization:read',
  'organization:update',
  'organization:delete',
  'members:read',
  'members:invite',
  'members:update',
  'members:remove',
  'gst:read',
  'gst:write',
  'gstin:read',
  'gstin:create',
  'gstin:update',
  'gstin:deactivate',
  'batches:read',
  'batches:process',
  'invoices:read',
  'invoices:write',
  'import:create',
  'import:read',
  'import:cancel'
];

export const ROLE_PERMISSIONS: Record<MembershipRole, Permission[]> = {
  OWNER: [...ALL_PERMISSIONS],
  ADMIN: [
    'organization:read',
    'organization:update',
    'members:read',
    'members:invite',
    'members:update',
    'members:remove',
    'gst:read',
    'gst:write',
    'gstin:read',
    'gstin:create',
    'gstin:update',
    'gstin:deactivate',
    'batches:read',
    'batches:process',
    'invoices:read',
    'invoices:write',
    'import:create',
    'import:read',
    'import:cancel'
  ],
  MEMBER: [
    'organization:read',
    'members:read',
    'gst:read',
    'gst:write',
    'gstin:read',
    'batches:read',
    'batches:process',
    'invoices:read',
    'invoices:write',
    'import:create',
    'import:read'
  ],
  VIEWER: [
    'organization:read',
    'members:read',
    'gst:read',
    'gstin:read',
    'batches:read',
    'invoices:read',
    'import:read'
  ]
};

const ROLE_HIERARCHY_LEVEL: Record<MembershipRole, number> = {
  OWNER: 4,
  ADMIN: 3,
  MEMBER: 2,
  VIEWER: 1
};

export function hasPermission(role: MembershipRole, permission: Permission): boolean {
  const permissions = ROLE_PERMISSIONS[role];
  return permissions ? permissions.includes(permission) : false;
}

export function getRolePermissions(role: MembershipRole): Permission[] {
  return ROLE_PERMISSIONS[role] ? [...ROLE_PERMISSIONS[role]] : [];
}

export function isRoleHigherOrEqual(roleA: MembershipRole, roleB: MembershipRole): boolean {
  return ROLE_HIERARCHY_LEVEL[roleA] >= ROLE_HIERARCHY_LEVEL[roleB];
}

export function isRoleStrictlyHigher(roleA: MembershipRole, roleB: MembershipRole): boolean {
  return ROLE_HIERARCHY_LEVEL[roleA] > ROLE_HIERARCHY_LEVEL[roleB];
}
