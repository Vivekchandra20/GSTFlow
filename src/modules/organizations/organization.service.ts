import crypto from 'crypto';
import { IOrganizationRepository } from './organization.repository.js';
import {
  OrganizationEntity,
  UserOrganizationItem
} from './organization.types.js';
import {
  CreateOrganizationBody,
  UpdateOrganizationBody
} from './organization.schemas.js';
import {
  OrganizationNotFoundError
} from '../authorization/authorization.errors.js';
import { logger } from '../../utils/logger.js';

export class OrganizationService {
  constructor(private readonly orgRepo: IOrganizationRepository) {}

  public async createOrganization(
    userId: string,
    input: CreateOrganizationBody
  ): Promise<{ organization: OrganizationEntity; membership: any }> {
    const id = crypto.randomUUID();
    const slug = input.slug || this.generateSlug(input.name);

    const result = await this.orgRepo.createOrganizationWithOwner({
      id,
      name: input.name.trim(),
      slug,
      pan: input.pan?.trim().toUpperCase() || null,
      userId
    });

    logger.info({
      event: 'ORGANIZATION_CREATED',
      organizationId: result.organization.id,
      creatorUserId: userId,
      slug: result.organization.slug
    }, 'Organization created with initial OWNER membership.');

    return result;
  }

  public async listUserOrganizations(userId: string): Promise<UserOrganizationItem[]> {
    return await this.orgRepo.listUserOrganizations(userId);
  }

  public async getOrganization(organizationId: string): Promise<OrganizationEntity> {
    return await this.orgRepo.runInTenantTransaction(organizationId, async (tx) => {
      const org = await this.orgRepo.getOrganizationById(organizationId, tx);
      if (!org) {
        throw new OrganizationNotFoundError();
      }
      return org;
    });
  }

  public async updateOrganization(
    organizationId: string,
    input: UpdateOrganizationBody
  ): Promise<OrganizationEntity> {
    return await this.orgRepo.runInTenantTransaction(organizationId, async (tx) => {
      const org = await this.orgRepo.getOrganizationById(organizationId, tx);
      if (!org) {
        throw new OrganizationNotFoundError();
      }

      const updated = await this.orgRepo.updateOrganization(
        organizationId,
        {
          name: input.name ? input.name.trim() : undefined,
          pan: input.pan ? input.pan.trim().toUpperCase() : undefined
        },
        tx
      );

      logger.info({
        event: 'ORGANIZATION_UPDATED',
        organizationId
      }, 'Organization details successfully updated.');

      return updated;
    });
  }

  private generateSlug(name: string): string {
    const clean = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
    const randomSuffix = crypto.randomBytes(3).toString('hex');
    return `${clean || 'org'}-${randomSuffix}`;
  }
}
