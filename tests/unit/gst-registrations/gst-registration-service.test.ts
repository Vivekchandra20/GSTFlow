import { describe, it, expect, beforeEach } from 'vitest';
import { GstRegistrationService } from '../../../src/modules/gst-registrations/gst-registration.service.js';
import { InMemoryGstRegistrationRepository } from '../../../src/modules/gst-registrations/in-memory-gst-registration.repository.js';
import {
  GstRegistrationNotFoundError,
  DuplicateGstinRegistrationError,
  InvalidGstinError,
  PanMismatchError,
  InvalidGstRegistrationStatusTransitionError
} from '../../../src/modules/gst-registrations/gst-registration.errors.js';

describe('GstRegistrationService (Unit Suite)', () => {
  let repo: InMemoryGstRegistrationRepository;
  let service: GstRegistrationService;
  const orgId = '11111111-2222-3333-4444-555555555555';

  beforeEach(() => {
    repo = new InMemoryGstRegistrationRepository();
    service = new GstRegistrationService(repo);
  });

  it('successfully creates a valid GST registration and extracts state code and PAN', async () => {
    const reg = await service.createRegistration(orgId, {
      gstin: '27AAPFU0939F1ZV',
      legalName: 'Acme Technologies Pvt Ltd',
      tradeName: 'Acme Tech',
      registrationType: 'REGULAR',
      effectiveDate: '2024-04-01'
    });

    expect(reg.id).toBeDefined();
    expect(reg.organizationId).toBe(orgId);
    expect(reg.gstin).toBe('27AAPFU0939F1ZV');
    expect(reg.legalName).toBe('Acme Technologies Pvt Ltd');
    expect(reg.tradeName).toBe('Acme Tech');
    expect(reg.stateCode).toBe('27');
    expect(reg.pan).toBe('AAPFU0939F');
    expect(reg.registrationType).toBe('REGULAR');
    expect(reg.status).toBe('ACTIVE');
    expect(reg.isActive).toBe(true);
    expect(reg.effectiveDate).toEqual(new Date('2024-04-01'));
  });

  it('rejects invalid or malformed GSTINs before database interaction', async () => {
    // Malformed length
    await expect(
      service.createRegistration(orgId, {
        gstin: '27AAPFU0939F1Z',
        legalName: 'Invalid Co'
      })
    ).rejects.toThrow(InvalidGstinError);

    // Invalid checksum character
    await expect(
      service.createRegistration(orgId, {
        gstin: '27AAPFU0939F1ZX', // Expected 'V'
        legalName: 'Invalid Checksum Co'
      })
    ).rejects.toThrow(InvalidGstinError);
  });

  it('enforces PAN alignment when organization has registered PAN', async () => {
    repo.setOrganizationPan(orgId, 'BBBBB0000B'); // Org PAN differs from GSTIN PAN ('AAPFU0939F')

    await expect(
      service.createRegistration(orgId, {
        gstin: '27AAPFU0939F1ZV',
        legalName: 'Mismatched PAN Co'
      })
    ).rejects.toThrow(PanMismatchError);
  });

  it('prevents duplicate GSTIN registration within the same organization', async () => {
    await service.createRegistration(orgId, {
      gstin: '27AAPFU0939F1ZV',
      legalName: 'Acme Primary'
    });

    await expect(
      service.createRegistration(orgId, {
        gstin: '27AAPFU0939F1ZV',
        legalName: 'Acme Duplicate'
      })
    ).rejects.toThrow(DuplicateGstinRegistrationError);
  });

  it('allows same GSTIN in distinct organizations without collision', async () => {
    const orgId2 = '99999999-8888-7777-6666-555555555555';

    const reg1 = await service.createRegistration(orgId, {
      gstin: '27AAPFU0939F1ZV',
      legalName: 'Org 1'
    });

    const reg2 = await service.createRegistration(orgId2, {
      gstin: '27AAPFU0939F1ZV',
      legalName: 'Org 2'
    });

    expect(reg1.organizationId).toBe(orgId);
    expect(reg2.organizationId).toBe(orgId2);
    expect(reg1.id).not.toBe(reg2.id);
  });

  it('lists registrations with filtering and pagination', async () => {
    await service.createRegistration(orgId, {
      gstin: '27AAPFU0939F1ZV',
      legalName: 'Maharashtra Entity',
      tradeName: 'Alpha Store'
    });

    await service.createRegistration(orgId, {
      gstin: '29AABCU9603R1ZJ',
      legalName: 'Karnataka Entity',
      tradeName: 'Beta Store'
    });

    // List all
    const listAll = await service.listRegistrations(orgId, {});
    expect(listAll.registrations).toHaveLength(2);
    expect(listAll.pagination.total).toBe(2);

    // Filter by state code '27'
    const list27 = await service.listRegistrations(orgId, { stateCode: '27' });
    expect(list27.registrations).toHaveLength(1);
    expect(list27.registrations[0].stateCode).toBe('27');

    // Search query 'Beta'
    const searchRes = await service.listRegistrations(orgId, { search: 'Beta' });
    expect(searchRes.registrations).toHaveLength(1);
    expect(searchRes.registrations[0].tradeName).toBe('Beta Store');
  });

  it('retrieves an individual registration by ID and throws 404 for unknown ID', async () => {
    const created = await service.createRegistration(orgId, {
      gstin: '27AAPFU0939F1ZV',
      legalName: 'Specific Entity'
    });

    const found = await service.getRegistration(orgId, created.id);
    expect(found.id).toBe(created.id);
    expect(found.legalName).toBe('Specific Entity');

    await expect(
      service.getRegistration(orgId, '00000000-0000-0000-0000-000000000000')
    ).rejects.toThrow(GstRegistrationNotFoundError);
  });

  it('updates permitted registration fields', async () => {
    const created = await service.createRegistration(orgId, {
      gstin: '27AAPFU0939F1ZV',
      legalName: 'Old Legal Name',
      tradeName: 'Old Trade'
    });

    const updated = await service.updateRegistration(orgId, created.id, {
      legalName: 'New Legal Name',
      tradeName: 'New Trade Name',
      registrationType: 'COMPOSITION'
    });

    expect(updated.legalName).toBe('New Legal Name');
    expect(updated.tradeName).toBe('New Trade Name');
    expect(updated.registrationType).toBe('COMPOSITION');
    expect(updated.gstin).toBe('27AAPFU0939F1ZV'); // GSTIN remains immutable
  });

  it('transitions registration status through valid lifecycle states', async () => {
    const created = await service.createRegistration(orgId, {
      gstin: '27AAPFU0939F1ZV',
      legalName: 'Lifecycle Entity'
    });

    // 1. ACTIVE -> SUSPENDED
    const suspended = await service.updateRegistrationStatus(orgId, created.id, {
      status: 'SUSPENDED',
      reason: 'Temporary audit review'
    });
    expect(suspended.status).toBe('SUSPENDED');
    expect(suspended.isActive).toBe(false);

    // 2. SUSPENDED -> ACTIVE
    const reactivated = await service.updateRegistrationStatus(orgId, created.id, {
      status: 'ACTIVE'
    });
    expect(reactivated.status).toBe('ACTIVE');
    expect(reactivated.isActive).toBe(true);

    // 3. ACTIVE -> CANCELLED
    const cancelled = await service.updateRegistrationStatus(orgId, created.id, {
      status: 'CANCELLED',
      cancellationDate: '2025-03-31',
      reason: 'Business closure'
    });
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.isActive).toBe(false);
    expect(cancelled.cancellationDate).toEqual(new Date('2025-03-31'));

    // 4. CANCELLED is terminal: CANCELLED -> ACTIVE rejected
    await expect(
      service.updateRegistrationStatus(orgId, created.id, {
        status: 'ACTIVE'
      })
    ).rejects.toThrow(InvalidGstRegistrationStatusTransitionError);
  });
});
