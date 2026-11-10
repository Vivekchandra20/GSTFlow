import crypto from 'crypto';
import { IGstRegistrationRepository } from './gst-registration.repository.js';
import {
  GstRegistrationEntity,
  GstRegistrationStatus,
  CreateGstRegistrationInput,
  UpdateGstRegistrationInput,
  UpdateGstRegistrationStatusInput,
  ListGstRegistrationsFilter,
  PaginatedGstRegistrations
} from './gst-registration.types.js';
import {
  GstRegistrationNotFoundError,
  DuplicateGstinRegistrationError,
  InvalidGstinError,
  PanMismatchError,
  InvalidGstRegistrationStatusTransitionError
} from './gst-registration.errors.js';
import { validateGstin } from '../../utils/gstin-validator.js';
import { logger } from '../../utils/logger.js';

export class GstRegistrationService {
  constructor(private readonly gstRepo: IGstRegistrationRepository) {}

  public async createRegistration(
    organizationId: string,
    input: CreateGstRegistrationInput
  ): Promise<GstRegistrationEntity> {
    // 1. Structural and Modulo-36 Checksum Validation
    const validation = validateGstin(input.gstin);
    if (!validation.isValid) {
      throw new InvalidGstinError(
        `Invalid GSTIN '${input.gstin}': ${validation.errors.join('; ')}`,
        validation.errors
      );
    }

    const { normalizedGstin, stateCode, pan } = validation;
    if (!stateCode || !pan) {
      throw new InvalidGstinError('Unable to extract state code and PAN from GSTIN.');
    }

    // 2. Tenant Context Execution & Duplicate / PAN Guards
    return await this.gstRepo.runInTenantTransaction(organizationId, async (tx) => {
      // Validate entity PAN alignment if organization has registered PAN
      const orgPan = await this.gstRepo.getOrganizationPan(organizationId, tx);
      if (orgPan && orgPan.trim().toUpperCase() !== pan) {
        throw new PanMismatchError(pan, orgPan.trim().toUpperCase());
      }

      // Check for duplicate GSTIN registration in this organization
      const existing = await this.gstRepo.findByGstin(organizationId, normalizedGstin, tx);
      if (existing) {
        throw new DuplicateGstinRegistrationError(normalizedGstin);
      }

      const id = crypto.randomUUID();
      const effectiveDate = input.effectiveDate ? new Date(input.effectiveDate) : null;

      const created = await this.gstRepo.create(
        organizationId,
        {
          id,
          organizationId,
          gstin: normalizedGstin,
          legalName: input.legalName.trim(),
          tradeName: input.tradeName ? input.tradeName.trim() : null,
          stateCode,
          pan,
          registrationType: input.registrationType || 'REGULAR',
          status: 'ACTIVE',
          isActive: true,
          effectiveDate
        },
        tx
      );

      logger.info(
        {
          event: 'GST_REGISTRATION_CREATED',
          organizationId,
          registrationId: created.id,
          stateCode: created.stateCode
        },
        'GST registration successfully registered for organization.'
      );

      return created;
    });
  }

  public async listRegistrations(
    organizationId: string,
    filter: ListGstRegistrationsFilter
  ): Promise<PaginatedGstRegistrations> {
    return await this.gstRepo.runInTenantTransaction(organizationId, async (tx) => {
      return await this.gstRepo.list(organizationId, filter, tx);
    });
  }

  public async getRegistration(
    organizationId: string,
    id: string
  ): Promise<GstRegistrationEntity> {
    return await this.gstRepo.runInTenantTransaction(organizationId, async (tx) => {
      const reg = await this.gstRepo.findById(organizationId, id, tx);
      if (!reg) {
        throw new GstRegistrationNotFoundError();
      }
      return reg;
    });
  }

  public async updateRegistration(
    organizationId: string,
    id: string,
    input: UpdateGstRegistrationInput
  ): Promise<GstRegistrationEntity> {
    return await this.gstRepo.runInTenantTransaction(organizationId, async (tx) => {
      const existing = await this.gstRepo.findById(organizationId, id, tx);
      if (!existing) {
        throw new GstRegistrationNotFoundError();
      }

      const updated = await this.gstRepo.update(
        organizationId,
        id,
        {
          legalName: input.legalName ? input.legalName.trim() : undefined,
          tradeName: input.tradeName !== undefined ? (input.tradeName ? input.tradeName.trim() : null) : undefined,
          registrationType: input.registrationType,
          effectiveDate: input.effectiveDate !== undefined ? (input.effectiveDate ? new Date(input.effectiveDate) : null) : undefined
        },
        tx
      );

      logger.info(
        {
          event: 'GST_REGISTRATION_UPDATED',
          organizationId,
          registrationId: id
        },
        'GST registration details updated.'
      );

      return updated;
    });
  }

  public async updateRegistrationStatus(
    organizationId: string,
    id: string,
    input: UpdateGstRegistrationStatusInput
  ): Promise<GstRegistrationEntity> {
    return await this.gstRepo.runInTenantTransaction(organizationId, async (tx) => {
      const existing = await this.gstRepo.findById(organizationId, id, tx);
      if (!existing) {
        throw new GstRegistrationNotFoundError();
      }

      const oldStatus = existing.status;
      const newStatus = input.status;

      // Idempotent no-op
      if (oldStatus === newStatus) {
        return existing;
      }

      // Enforce valid lifecycle state transitions
      this.validateStatusTransition(oldStatus, newStatus);

      const isActive = newStatus === 'ACTIVE';
      let cancellationDate: Date | null | undefined = undefined;

      if (newStatus === 'CANCELLED') {
        cancellationDate = input.cancellationDate ? new Date(input.cancellationDate) : new Date();
      } else if (oldStatus === 'CANCELLED') {
        cancellationDate = null;
      }

      const updated = await this.gstRepo.updateStatus(
        organizationId,
        id,
        {
          status: newStatus,
          isActive,
          cancellationDate
        },
        tx
      );

      logger.info(
        {
          event: 'GST_REGISTRATION_STATUS_UPDATED',
          organizationId,
          registrationId: id,
          oldStatus,
          newStatus,
          reason: input.reason || null
        },
        `GST registration status transitioned from ${oldStatus} to ${newStatus}.`
      );

      return updated;
    });
  }

  private validateStatusTransition(from: GstRegistrationStatus, to: GstRegistrationStatus): void {
    // Terminal state: CANCELLED registration cannot be transitioned back
    if (from === 'CANCELLED') {
      throw new InvalidGstRegistrationStatusTransitionError(from, to);
    }

    const validTransitions: Record<GstRegistrationStatus, GstRegistrationStatus[]> = {
      ACTIVE: ['SUSPENDED', 'INACTIVE', 'CANCELLED'],
      SUSPENDED: ['ACTIVE', 'INACTIVE', 'CANCELLED'],
      INACTIVE: ['ACTIVE', 'CANCELLED'],
      CANCELLED: []
    };

    const allowed = validTransitions[from] || [];
    if (!allowed.includes(to)) {
      throw new InvalidGstRegistrationStatusTransitionError(from, to);
    }
  }
}
