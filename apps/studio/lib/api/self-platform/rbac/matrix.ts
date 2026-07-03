// [self-platform] Role -> grant-template matrix, v1 (spec §5, authoritative).
// The matrix lives in code, not the database: platform.roles stores role
// IDENTITY; what a base role may do is versioned here with the branch.
// Any deviation found during implementation must be reviewer-sanctioned and
// recorded in progress.md — no silent edits.
import { PermissionAction } from '@supabase/shared-types/out/constants'

export type GrantTemplate = {
  actions: string[]
  resources: string[]
  condition: Record<string, unknown> | null
  restrictive?: boolean
}

/** Mirrors FIXED_ROLE_ORDER in data/organization-members/organization-roles-query.ts
 * (client module — not importable from server code; equality is test-asserted). */
export const BASE_ROLE_ORDER: readonly string[] = [
  'Owner',
  'Administrator',
  'Developer',
  'Read-only',
]

/** Seeded id of the Owner base role (04-roles.sql). */
export const OWNER_ROLE_ID = 1

const READ_ACTIONS: string[] = [
  PermissionAction.READ, // read:Read
  PermissionAction.ANALYTICS_READ,
  PermissionAction.ANALYTICS_ADMIN_READ,
  PermissionAction.FUNCTIONS_READ,
  PermissionAction.SQL_SELECT, // sql:Read:Select
  PermissionAction.TENANT_SQL_QUERY,
  PermissionAction.TENANT_SQL_SELECT,
  PermissionAction.TENANT_SQL_ADMIN_READ,
  PermissionAction.STORAGE_READ,
  PermissionAction.STORAGE_ADMIN_READ,
  PermissionAction.REALTIME_ADMIN_READ,
  PermissionAction.REPLICATION_ADMIN_READ,
]

const DEVELOPER_WRITE_ACTIONS: string[] = [
  'tenant:Sql:%', // all tenant SQL actions (query/select/writes/CreateTable/Admin)
  'sql:%', // control-plane sql actions
  PermissionAction.STORAGE_WRITE,
  PermissionAction.STORAGE_ADMIN_WRITE,
  PermissionAction.FUNCTIONS_WRITE,
  PermissionAction.FUNCTIONS_SECRET_READ,
  PermissionAction.FUNCTIONS_SECRET_WRITE,
  PermissionAction.AUTH_EXECUTE,
  PermissionAction.ANALYTICS_WRITE,
]

// Deny granting/revoking the Owner role — attached restrictively so it
// overrides Administrator's `%` permissive grant (deny-first evaluation).
// Spec §5 phrased this as a permissive condition `!== OWNER`; this restrictive
// `== OWNER` deny is the same semantics (recorded deviation).
const DENY_OWNER_ROLE_GRANTS: GrantTemplate = {
  actions: [PermissionAction.CREATE, PermissionAction.DELETE],
  resources: ['user_invites', 'auth.subject_roles'],
  condition: { '==': [{ var: 'resource.role_id' }, OWNER_ROLE_ID] },
  restrictive: true,
}

export const ROLE_MATRIX: Record<string, GrantTemplate[]> = {
  Owner: [{ actions: ['%'], resources: ['%'], condition: null }],
  Administrator: [
    { actions: ['%'], resources: ['%'], condition: null },
    // Organization-level writes stay Owner-only.
    { actions: ['write:%'], resources: ['organizations'], condition: null, restrictive: true },
    DENY_OWNER_ROLE_GRANTS,
  ],
  Developer: [
    { actions: READ_ACTIONS, resources: ['%'], condition: null },
    { actions: DEVELOPER_WRITE_ACTIONS, resources: ['%'], condition: null },
    // User content (SQL snippets etc.) uses generic CRUD actions.
    { actions: ['write:%'], resources: ['user_content'], condition: null },
  ],
  'Read-only': [{ actions: READ_ACTIONS, resources: ['%'], condition: null }],
}
