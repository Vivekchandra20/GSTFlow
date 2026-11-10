import { PrismaClient, Prisma } from '@prisma/client';
import {
  GstRegistrationEntity,
  GstRegistrationStatus,
  GstRegistrationType,
  ListGstRegistrationsFilter,
  PaginatedGstRegistrations
} from './gst-registration.types.js';
import { runInTenantTransaction } from '../../repositories/prisma/tenant-context.js';

export interface CreateGstRegistrationRepoData {
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
  effectiveDate?: Date | null;
}

export interface UpdateGstRegistrationRepoData {
  legalName?: string;
  tradeName?: string | null;
  registrationType?: GstRegistrationType;
  effectiveDate?: Date | null;
}

export interface UpdateGstRegistrationStatusRepoData {
  status: GstRegistrationStatus;
  isActive: boolean;
  cancellationDate?: Date | null;
}

export interface IGstRegistrationRepository {
  create(
    organizationId: string,
    data: CreateGstRegistrationRepoData,
    tx?: any
  ): Promise<GstRegistrationEntity>;

  findById(
    organizationId: string,
    id: string,
    tx?: any
  ): Promise<GstRegistrationEntity | null>;

  findByGstin(
    organizationId: string,
    gstin: string,
    tx?: any
  ): Promise<GstRegistrationEntity | null>;

  findByGstinForUpdate(
    organizationId: string,
    gstin: string,
    tx: any
  ): Promise<GstRegistrationEntity | null>;

  list(
    organizationId: string,
    filter: ListGstRegistrationsFilter,
    tx?: any
  ): Promise<PaginatedGstRegistrations>;

  update(
    organizationId: string,
    id: string,
    data: UpdateGstRegistrationRepoData,
    tx?: any
  ): Promise<GstRegistrationEntity>;

  updateStatus(
    organizationId: string,
    id: string,
    data: UpdateGstRegistrationStatusRepoData,
    tx?: any
  ): Promise<GstRegistrationEntity>;

  getOrganizationPan(organizationId: string, tx?: any): Promise<string | null>;

  runInTenantTransaction<T>(
    organizationId: string,
    fn: (tx: any) => Promise<T>
  ): Promise<T>;
}

export class PrismaGstRegistrationRepository implements IGstRegistrationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  public async create(
    organizationId: string,
    data: CreateGstRegistrationRepoData,
    tx?: any
  ): Promise<GstRegistrationEntity> {
    const client = tx || this.prisma;
    const row = await (client as any).gstRegistration.create({
      data: {
        id: data.id,
        organizationId,
        gstin: data.gstin,
        legalName: data.legalName,
        tradeName: data.tradeName || null,
        stateCode: data.stateCode,
        pan: data.pan,
        registrationType: data.registrationType,
        status: data.status,
        isActive: data.isActive,
        effectiveDate: data.effectiveDate || null
      }
    });

    return this.mapEntity(row);
  }

  public async findById(
    organizationId: string,
    id: string,
    tx?: any
  ): Promise<GstRegistrationEntity | null> {
    const client = tx || this.prisma;
    const row = await (client as any).gstRegistration.findFirst({
      where: {
        id,
        organizationId
      }
    });

    return row ? this.mapEntity(row) : null;
  }

  public async findByGstin(
    organizationId: string,
    gstin: string,
    tx?: any
  ): Promise<GstRegistrationEntity | null> {
    const client = tx || this.prisma;
    const row = await (client as any).gstRegistration.findFirst({
      where: {
        organizationId,
        gstin
      }
    });

    return row ? this.mapEntity(row) : null;
  }

  public async findByGstinForUpdate(
    organizationId: string,
    gstin: string,
    tx: any
  ): Promise<GstRegistrationEntity | null> {
    const rows = await tx.$queryRaw<any[]>`
      SELECT * FROM gst_registrations
      WHERE organization_id = ${organizationId}::uuid
        AND gstin = ${gstin}
      FOR UPDATE;
    `;

    return rows.length > 0 ? this.mapEntity(rows[0]) : null;
  }

  public async list(
    organizationId: string,
    filter: ListGstRegistrationsFilter,
    tx?: any
  ): Promise<PaginatedGstRegistrations> {
    const client = tx || this.prisma;
    const page = filter.page && filter.page > 0 ? filter.page : 1;
    const limit = filter.limit && filter.limit > 0 ? Math.min(filter.limit, 100) : 20;
    const skip = (page - 1) * limit;

    const where: any = { organizationId };

    if (filter.status) {
      where.status = filter.status;
    }
    if (filter.stateCode) {
      where.stateCode = filter.stateCode;
    }
    if (filter.search && filter.search.trim()) {
      const s = filter.search.trim();
      where.OR = [
        { gstin: { contains: s, mode: 'insensitive' } },
        { legalName: { contains: s, mode: 'insensitive' } },
        { tradeName: { contains: s, mode: 'insensitive' } }
      ];
    }

    const [total, rows] = await Promise.all([
      (client as any).gstRegistration.count({ where }),
      (client as any).gstRegistration.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { gstin: 'asc' }],
        skip,
        take: limit
      })
    ]);

    return {
      registrations: rows.map((r: any) => this.mapEntity(r)),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1
      }
    };
  }

  public async update(
    organizationId: string,
    id: string,
    data: UpdateGstRegistrationRepoData,
    tx?: any
  ): Promise<GstRegistrationEntity> {
    const client = tx || this.prisma;
    const updateData: any = {};
    if (data.legalName !== undefined) updateData.legalName = data.legalName;
    if (data.tradeName !== undefined) updateData.tradeName = data.tradeName;
    if (data.registrationType !== undefined) updateData.registrationType = data.registrationType;
    if (data.effectiveDate !== undefined) updateData.effectiveDate = data.effectiveDate;

    const row = await (client as any).gstRegistration.update({
      where: {
        organizationId_id: {
          organizationId,
          id
        }
      },
      data: updateData
    });

    return this.mapEntity(row);
  }

  public async updateStatus(
    organizationId: string,
    id: string,
    data: UpdateGstRegistrationStatusRepoData,
    tx?: any
  ): Promise<GstRegistrationEntity> {
    const client = tx || this.prisma;
    const updateData: any = {
      status: data.status,
      isActive: data.isActive
    };
    if (data.cancellationDate !== undefined) {
      updateData.cancellationDate = data.cancellationDate;
    }

    const row = await (client as any).gstRegistration.update({
      where: {
        organizationId_id: {
          organizationId,
          id
        }
      },
      data: updateData
    });

    return this.mapEntity(row);
  }

  public async getOrganizationPan(organizationId: string, tx?: any): Promise<string | null> {
    const client = tx || this.prisma;
    const org = await (client as any).organization.findUnique({
      where: { id: organizationId },
      select: { pan: true }
    });
    return org ? org.pan : null;
  }

  public async runInTenantTransaction<T>(
    organizationId: string,
    fn: (tx: any) => Promise<T>
  ): Promise<T> {
    return await runInTenantTransaction(
      this.prisma,
      { organizationId },
      async (tx) => await fn(tx)
    );
  }

  private mapEntity(row: any): GstRegistrationEntity {
    return {
      id: row.id,
      organizationId: row.organizationId || row.organization_id,
      gstin: row.gstin,
      legalName: row.legalName || row.legal_name,
      tradeName: row.tradeName !== undefined ? row.tradeName : (row.trade_name || null),
      stateCode: row.stateCode || row.state_code,
      pan: row.pan,
      registrationType: (row.registrationType || row.registration_type || 'REGULAR') as GstRegistrationType,
      status: (row.status || (row.is_active ? 'ACTIVE' : 'INACTIVE')) as GstRegistrationStatus,
      isActive: row.isActive !== undefined ? Boolean(row.isActive) : Boolean(row.is_active),
      effectiveDate: row.effectiveDate || row.effective_date || null,
      cancellationDate: row.cancellationDate || row.cancellation_date || null,
      createdAt: row.createdAt || row.created_at,
      updatedAt: row.updatedAt || row.updated_at
    };
  }
}
