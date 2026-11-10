export type GstRegistrationStatus = 'ACTIVE' | 'CANCELLED' | 'SUSPENDED' | 'INACTIVE';

export type GstRegistrationType =
  | 'REGULAR'
  | 'COMPOSITION'
  | 'ISD'
  | 'CASUAL'
  | 'NON_RESIDENT'
  | 'TCS_ECO'
  | 'TDS'
  | 'OIDAR';

export interface GstRegistrationEntity {
  id: string;
  organizationId: string;
  gstin: string;
  legalName: string;
  tradeName: string | null;
  stateCode: string;
  pan: string;
  registrationType: GstRegistrationType;
  status: GstRegistrationStatus;
  isActive: boolean;
  effectiveDate: Date | null;
  cancellationDate: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateGstRegistrationInput {
  gstin: string;
  legalName: string;
  tradeName?: string | null;
  registrationType?: GstRegistrationType;
  effectiveDate?: string | Date | null;
}

export interface UpdateGstRegistrationInput {
  legalName?: string;
  tradeName?: string | null;
  registrationType?: GstRegistrationType;
  effectiveDate?: string | Date | null;
}

export interface UpdateGstRegistrationStatusInput {
  status: GstRegistrationStatus;
  cancellationDate?: string | Date | null;
  reason?: string;
}

export interface ListGstRegistrationsFilter {
  status?: GstRegistrationStatus;
  stateCode?: string;
  search?: string;
  page?: number;
  limit?: number;
}

export interface PaginatedGstRegistrations {
  registrations: GstRegistrationEntity[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
