/**
 * GSTFlow REST API Data Types & Contracts (Phase 4.2 Compliant)
 */

export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
  statusCode?: number;
}

export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown[];
  };
  requestId: string;
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

// User & Auth
export interface User {
  id: string;
  email: string;
  status: 'ACTIVE' | 'DISABLED' | 'SUSPENDED';
  emailVerified: boolean;
  createdAt: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  tokenType: string;
}

export interface AuthResult {
  user: User;
  tokens: AuthTokens;
}

// Organizations & Memberships
export type OrganizationRole = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';
export type MembershipStatus = 'ACTIVE' | 'INVITED' | 'SUSPENDED';

export interface UserOrganization {
  id: string;
  name: string;
  slug: string;
  status: 'ACTIVE' | 'SUSPENDED';
  role: OrganizationRole;
  membershipStatus: MembershipStatus;
  joinedAt: string;
}

export interface OrganizationDetails {
  id: string;
  name: string;
  slug: string;
  pan?: string | null;
  status: 'ACTIVE' | 'SUSPENDED';
  dataRetentionMonths: number;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationMember {
  id: string;
  userId: string;
  email: string;
  role: OrganizationRole;
  status: MembershipStatus;
  joinedAt: string;
}

export interface OrganizationInvitation {
  id: string;
  email: string;
  role: OrganizationRole;
  invitedByUserId: string;
  status: 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';
  expiresAt: string;
  createdAt: string;
  invitationToken?: string;
}

export interface PendingInvitation {
  id: string;
  organizationId: string;
  organizationName: string;
  organizationSlug?: string;
  email: string;
  role: OrganizationRole;
  invitedByUserId?: string | null;
  invitedByEmail?: string | null;
  expiresAt: string;
  createdAt: string;
}

// GST Registrations
export type GstRegistrationType =
  | 'REGULAR'
  | 'COMPOSITION'
  | 'ISD'
  | 'CASUAL'
  | 'NON_RESIDENT'
  | 'TCS_ECO'
  | 'TDS'
  | 'OIDAR';

export type GstRegistrationStatus = 'ACTIVE' | 'CANCELLED' | 'SUSPENDED' | 'INACTIVE';

export interface GstRegistration {
  id: string;
  organizationId: string;
  gstin: string;
  legalName: string;
  tradeName?: string | null;
  stateCode: string;
  pan: string;
  registrationType: GstRegistrationType;
  status: GstRegistrationStatus;
  isActive: boolean;
  effectiveDate?: string | null;
  cancellationDate?: string | null;
  createdAt: string;
  updatedAt: string;
}

// Imports & Batches
export type ImportBatchStatus =
  | 'UPLOAD_RECEIVED'
  | 'STAGING'
  | 'STAGING_COMPLETED'
  | 'QUEUED'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'FAILED';

export interface ImportSourceFile {
  id: string;
  fileName: string;
  status: 'STAGED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  recordCount: number;
  fileSizeBytes: string | number;
  fileHash: string;
}

export interface ImportBatchItem {
  id: string;
  organizationId: string;
  batchNumber: string;
  status: ImportBatchStatus;
  gstRegistrationId: string;
  sourcePlatform: 'AMAZON' | 'FLIPKART' | 'MEESHO' | 'CUSTOM';
  executionMode: 'STANDARD' | 'REPROCESSING';
  engineVersion: string;
  rulesVersion: string;
  totalRecordsProcessed: number;
  files: ImportSourceFile[];
  createdAt: string;
  completedAt?: string | null;
}

export interface ImportBatchStatusResponse {
  batchId: string;
  batchNumber: string;
  status: ImportBatchStatus;
  job?: {
    id: string;
    status: 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
    checkpoint: string;
    currentAttempt: number;
    maxAttempts: number;
    progressPercentage: number;
    errorMessage?: string | null;
  };
  files: Array<{
    fileName: string;
    status: string;
    recordsProcessed: number;
  }>;
  recordsProcessed: number;
}

export interface ImportSummaryResponse {
  batchId: string;
  batchNumber: string;
  status: ImportBatchStatus;
  totalRecords: number;
  invoices: {
    b2b: number;
    b2c: number;
    totalTaxableAmount: string;
    totalCgstAmount: string;
    totalSgstAmount: string;
    totalIgstAmount: string;
  };
  creditNotes: {
    count: number;
    reconciledFull: number;
    reconciledPartial: number;
    unreconciled: number;
    totalReversedAmount: string;
  };
  stockTransfers: {
    count: number;
    distinctPersonCount: number;
  };
  durationMs: number;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}
