import { apiClient } from './client';
import {
  GstRegistration,
  GstRegistrationStatus,
  GstRegistrationType,
  Pagination
} from './types';

export interface CreateGstRegistrationPayload {
  gstin: string;
  legalName: string;
  tradeName?: string;
  registrationType?: GstRegistrationType;
  effectiveDate?: string;
}

export interface UpdateGstRegistrationPayload {
  legalName?: string;
  tradeName?: string;
  registrationType?: GstRegistrationType;
  effectiveDate?: string;
}

export interface UpdateGstRegistrationStatusPayload {
  status: GstRegistrationStatus;
  cancellationDate?: string;
  reason?: string;
}

export interface ListGstRegistrationsParams {
  status?: GstRegistrationStatus;
  stateCode?: string;
  search?: string;
  page?: number;
  limit?: number;
}

export const gstRegistrationsApi = {
  async list(
    organizationId: string,
    params?: ListGstRegistrationsParams
  ): Promise<{ registrations: GstRegistration[]; pagination: Pagination }> {
    return apiClient<{ registrations: GstRegistration[]; pagination: Pagination }>(
      `/organizations/${organizationId}/gst-registrations`,
      { params: params as any }
    );
  },

  async get(organizationId: string, gstRegistrationId: string): Promise<{ gstRegistration: GstRegistration }> {
    return apiClient<{ gstRegistration: GstRegistration }>(
      `/organizations/${organizationId}/gst-registrations/${gstRegistrationId}`
    );
  },

  async create(
    organizationId: string,
    payload: CreateGstRegistrationPayload
  ): Promise<{ gstRegistration: GstRegistration }> {
    return apiClient<{ gstRegistration: GstRegistration }>(
      `/organizations/${organizationId}/gst-registrations`,
      {
        method: 'POST',
        body: JSON.stringify(payload)
      }
    );
  },

  async update(
    organizationId: string,
    gstRegistrationId: string,
    payload: UpdateGstRegistrationPayload
  ): Promise<{ gstRegistration: GstRegistration }> {
    return apiClient<{ gstRegistration: GstRegistration }>(
      `/organizations/${organizationId}/gst-registrations/${gstRegistrationId}`,
      {
        method: 'PATCH',
        body: JSON.stringify(payload)
      }
    );
  },

  async updateStatus(
    organizationId: string,
    gstRegistrationId: string,
    payload: UpdateGstRegistrationStatusPayload
  ): Promise<{ gstRegistration: GstRegistration }> {
    return apiClient<{ gstRegistration: GstRegistration }>(
      `/organizations/${organizationId}/gst-registrations/${gstRegistrationId}/status`,
      {
        method: 'PATCH',
        body: JSON.stringify(payload)
      }
    );
  }
};
