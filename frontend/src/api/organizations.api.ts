import { apiClient } from './client';
import {
  OrganizationDetails,
  OrganizationMember,
  OrganizationRole,
  UserOrganization
} from './types';

export interface CreateOrganizationPayload {
  name: string;
  slug?: string;
  pan?: string;
}

export interface UpdateOrganizationPayload {
  name?: string;
  pan?: string;
}

export const organizationsApi = {
  async listUserOrganizations(): Promise<{ organizations: UserOrganization[] }> {
    return apiClient<{ organizations: UserOrganization[] }>('/organizations');
  },

  async createOrganization(payload: CreateOrganizationPayload): Promise<{ organization: OrganizationDetails; membership: any }> {
    return apiClient<{ organization: OrganizationDetails; membership: any }>('/organizations', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  async getOrganization(organizationId: string): Promise<OrganizationDetails> {
    return apiClient<OrganizationDetails>(`/organizations/${organizationId}`);
  },

  async updateOrganization(organizationId: string, payload: UpdateOrganizationPayload): Promise<OrganizationDetails> {
    return apiClient<OrganizationDetails>(`/organizations/${organizationId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload)
    });
  },

  async listMembers(organizationId: string): Promise<{ members: OrganizationMember[] }> {
    return apiClient<{ members: OrganizationMember[] }>(`/organizations/${organizationId}/members`);
  },

  async updateMemberRole(
    organizationId: string,
    targetUserId: string,
    role: OrganizationRole
  ): Promise<any> {
    return apiClient<any>(`/organizations/${organizationId}/members/${targetUserId}/role`, {
      method: 'PATCH',
      body: JSON.stringify({ role })
    });
  },

  async removeMember(organizationId: string, targetUserId: string): Promise<{ message: string }> {
    return apiClient<{ message: string }>(`/organizations/${organizationId}/members/${targetUserId}`, {
      method: 'DELETE'
    });
  },

  async leaveOrganization(organizationId: string): Promise<{ message: string }> {
    return apiClient<{ message: string }>(`/organizations/${organizationId}/leave`, {
      method: 'POST'
    });
  }
};
