import { apiClient } from './client';
import { OrganizationInvitation, OrganizationRole, PendingInvitation } from './types';

export interface CreateInvitationPayload {
  email: string;
  role: OrganizationRole;
}

export interface AcceptInvitationPayload {
  token?: string;
  invitationId?: string;
}

export const invitationsApi = {
  async list(organizationId: string): Promise<{ invitations: OrganizationInvitation[] }> {
    return apiClient<{ invitations: OrganizationInvitation[] }>(
      `/organizations/${organizationId}/invitations`
    );
  },

  async listPending(): Promise<{ invitations: PendingInvitation[] }> {
    return apiClient<{ invitations: PendingInvitation[] }>('/invitations/pending');
  },

  async create(
    organizationId: string,
    payload: CreateInvitationPayload
  ): Promise<{ invitation: OrganizationInvitation; invitationToken: string }> {
    return apiClient<{ invitation: OrganizationInvitation; invitationToken: string }>(
      `/organizations/${organizationId}/invitations`,
      {
        method: 'POST',
        body: JSON.stringify(payload)
      }
    );
  },

  async revoke(organizationId: string, invitationId: string): Promise<{ message: string }> {
    return apiClient<{ message: string }>(
      `/organizations/${organizationId}/invitations/${invitationId}`,
      {
        method: 'DELETE'
      }
    );
  },

  async accept(
    payloadOrToken: string | AcceptInvitationPayload
  ): Promise<{ organizationId: string; membershipId: string; role: OrganizationRole }> {
    const body = typeof payloadOrToken === 'string' ? { token: payloadOrToken } : payloadOrToken;
    return apiClient<{ organizationId: string; membershipId: string; role: OrganizationRole }>(
      '/invitations/accept',
      {
        method: 'POST',
        body: JSON.stringify(body)
      }
    );
  },

  async decline(invitationId: string): Promise<{ message: string }> {
    return apiClient<{ message: string }>(`/invitations/${invitationId}/decline`, {
      method: 'POST'
    });
  }
};
