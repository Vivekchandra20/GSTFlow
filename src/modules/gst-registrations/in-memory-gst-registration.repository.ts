import {
  GstRegistrationEntity,
  ListGstRegistrationsFilter,
  PaginatedGstRegistrations
} from './gst-registration.types.js';
import {
  IGstRegistrationRepository,
  CreateGstRegistrationRepoData,
  UpdateGstRegistrationRepoData,
  UpdateGstRegistrationStatusRepoData
} from './gst-registration.repository.js';

export class InMemoryGstRegistrationRepository implements IGstRegistrationRepository {
  public registrations: Map<string, GstRegistrationEntity> = new Map();
  public organizationPans: Map<string, string | null> = new Map();

  public async create(
    organizationId: string,
    data: CreateGstRegistrationRepoData,
    _tx?: any
  ): Promise<GstRegistrationEntity> {
    const key = `${organizationId}:${data.gstin}`;
    const entity: GstRegistrationEntity = {
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
      effectiveDate: data.effectiveDate || null,
      cancellationDate: null,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    this.registrations.set(`${organizationId}:${data.id}`, entity);
    this.registrations.set(key, entity);
    return { ...entity };
  }

  public async findById(
    organizationId: string,
    id: string,
    _tx?: any
  ): Promise<GstRegistrationEntity | null> {
    const entity = this.registrations.get(`${organizationId}:${id}`);
    return entity ? { ...entity } : null;
  }

  public async findByGstin(
    organizationId: string,
    gstin: string,
    _tx?: any
  ): Promise<GstRegistrationEntity | null> {
    const entity = this.registrations.get(`${organizationId}:${gstin}`);
    return entity ? { ...entity } : null;
  }

  public async findByGstinForUpdate(
    organizationId: string,
    gstin: string,
    _tx: any
  ): Promise<GstRegistrationEntity | null> {
    return this.findByGstin(organizationId, gstin, _tx);
  }

  public async list(
    organizationId: string,
    filter: ListGstRegistrationsFilter,
    _tx?: any
  ): Promise<PaginatedGstRegistrations> {
    const page = filter.page && filter.page > 0 ? filter.page : 1;
    const limit = filter.limit && filter.limit > 0 ? Math.min(filter.limit, 100) : 20;

    let items = Array.from(this.registrations.values()).filter(
      (r, idx, self) =>
        r.organizationId === organizationId && self.findIndex((s) => s.id === r.id) === idx
    );

    if (filter.status) {
      items = items.filter((r) => r.status === filter.status);
    }
    if (filter.stateCode) {
      items = items.filter((r) => r.stateCode === filter.stateCode);
    }
    if (filter.search && filter.search.trim()) {
      const q = filter.search.trim().toLowerCase();
      items = items.filter(
        (r) =>
          r.gstin.toLowerCase().includes(q) ||
          r.legalName.toLowerCase().includes(q) ||
          (r.tradeName && r.tradeName.toLowerCase().includes(q))
      );
    }

    // Sort by createdAt desc, gstin asc
    items.sort((a, b) => {
      const dateDiff = b.createdAt.getTime() - a.createdAt.getTime();
      return dateDiff !== 0 ? dateDiff : a.gstin.localeCompare(b.gstin);
    });

    const total = items.length;
    const skip = (page - 1) * limit;
    const paged = items.slice(skip, skip + limit);

    return {
      registrations: paged.map((r) => ({ ...r })),
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
    _tx?: any
  ): Promise<GstRegistrationEntity> {
    const existing = this.registrations.get(`${organizationId}:${id}`);
    if (!existing) {
      throw new Error(`GST registration ${id} not found in ${organizationId}`);
    }

    if (data.legalName !== undefined) existing.legalName = data.legalName;
    if (data.tradeName !== undefined) existing.tradeName = data.tradeName;
    if (data.registrationType !== undefined) existing.registrationType = data.registrationType;
    if (data.effectiveDate !== undefined) existing.effectiveDate = data.effectiveDate;
    existing.updatedAt = new Date();

    this.registrations.set(`${organizationId}:${id}`, existing);
    this.registrations.set(`${organizationId}:${existing.gstin}`, existing);

    return { ...existing };
  }

  public async updateStatus(
    organizationId: string,
    id: string,
    data: UpdateGstRegistrationStatusRepoData,
    _tx?: any
  ): Promise<GstRegistrationEntity> {
    const existing = this.registrations.get(`${organizationId}:${id}`);
    if (!existing) {
      throw new Error(`GST registration ${id} not found in ${organizationId}`);
    }

    existing.status = data.status;
    existing.isActive = data.isActive;
    if (data.cancellationDate !== undefined) {
      existing.cancellationDate = data.cancellationDate;
    }
    existing.updatedAt = new Date();

    this.registrations.set(`${organizationId}:${id}`, existing);
    this.registrations.set(`${organizationId}:${existing.gstin}`, existing);

    return { ...existing };
  }

  public async getOrganizationPan(organizationId: string, _tx?: any): Promise<string | null> {
    return this.organizationPans.get(organizationId) || null;
  }

  public setOrganizationPan(organizationId: string, pan: string | null): void {
    this.organizationPans.set(organizationId, pan);
  }

  public async runInTenantTransaction<T>(
    _organizationId: string,
    fn: (tx: any) => Promise<T>
  ): Promise<T> {
    return await fn(this);
  }

  public clear(): void {
    this.registrations.clear();
    this.organizationPans.clear();
  }
}
