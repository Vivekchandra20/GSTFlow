import { z } from 'zod';

export const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;
export const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const CreateOrganizationBodySchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters long').max(200),
  slug: z.string().trim().min(2).max(255).regex(SLUG_REGEX, 'Slug must be lower-case alphanumeric and hyphens').optional(),
  pan: z.string().trim().regex(PAN_REGEX, 'Invalid Indian PAN format').optional()
});

export type CreateOrganizationBody = z.infer<typeof CreateOrganizationBodySchema>;

export const UpdateOrganizationBodySchema = z.object({
  name: z.string().trim().min(2).max(200).optional(),
  pan: z.string().trim().regex(PAN_REGEX, 'Invalid Indian PAN format').optional()
}).refine(data => data.name !== undefined || data.pan !== undefined, {
  message: 'At least one field (name or pan) must be provided for update'
});

export type UpdateOrganizationBody = z.infer<typeof UpdateOrganizationBodySchema>;

export const UpdateMemberRoleBodySchema = z.object({
  role: z.enum(['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'])
});

export type UpdateMemberRoleBody = z.infer<typeof UpdateMemberRoleBodySchema>;

export const CreateInvitationBodySchema = z.object({
  email: z.string().trim().email('Invalid email address format').max(255),
  role: z.enum(['ADMIN', 'MEMBER', 'VIEWER'], {
    errorMap: () => ({ message: "Invitations can only be issued for 'ADMIN', 'MEMBER', or 'VIEWER' roles." })
  })
});

export type CreateInvitationBody = z.infer<typeof CreateInvitationBodySchema>;

export const AcceptInvitationBodySchema = z.object({
  token: z.string().min(20, 'Invalid invitation token format').max(256).optional(),
  invitationId: z.string().uuid('Invalid invitation ID format').optional()
}).refine(data => data.token !== undefined || data.invitationId !== undefined, {
  message: 'Either token or invitationId must be provided'
});

export type AcceptInvitationBody = z.infer<typeof AcceptInvitationBodySchema>;
