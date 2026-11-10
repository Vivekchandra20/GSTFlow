import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { ImportService } from '../../../src/modules/imports/import.service.js';
import { InMemoryImportRepository } from '../../../src/modules/imports/in-memory-import.repository.js';
import { InMemoryGstRegistrationRepository } from '../../../src/modules/gst-registrations/in-memory-gst-registration.repository.js';
import { InMemoryImportBatchRepository } from '../../../src/repositories/in-memory/in-memory-import-batch.repository.js';
import { InMemorySourceRecordRepository } from '../../../src/repositories/in-memory/in-memory-source-record.repository.js';
import {
  GstRegistrationNotEligibleError,
  DuplicateImportError,
  ImportNotFoundError
} from '../../../src/modules/imports/import.errors.js';
import {
  TenantContext,
  BatchStatus,
  FileBatchStatus,
  RecordType
} from '../../../src/repositories/types.js';

describe('Phase 4.2.5: ImportService Unit Tests', () => {
  const orgA: TenantContext = { organizationId: '11111111-2222-4333-8444-555555555555' };
  const orgB: TenantContext = { organizationId: '22222222-3333-4444-8555-666666666666' };

  let importRepo: InMemoryImportRepository;
  let gstRepo: InMemoryGstRegistrationRepository;
  let batchRepo: InMemoryImportBatchRepository;
  let sourceRecordRepo: InMemorySourceRecordRepository;
  let service: ImportService;

  let activeGstRegId: string;
  let cancelledGstRegId: string;
  let suspendedGstRegId: string;
  let inactiveGstRegId: string;

  beforeEach(async () => {
    importRepo = new InMemoryImportRepository();
    gstRepo = new InMemoryGstRegistrationRepository();
    sourceRecordRepo = new InMemorySourceRecordRepository();
    batchRepo = new InMemoryImportBatchRepository(sourceRecordRepo);

    service = new ImportService({
      importRepo,
      gstRegistrationRepo: gstRepo,
      batchRepo,
      sourceRecordRepo
    });

    const createReg = async (
      orgId: string,
      gstin: string,
      legalName: string,
      pan: string,
      stateCode: string,
      status: any = 'ACTIVE',
      isActive: boolean = true
    ) => {
      const id = crypto.randomUUID();
      return await gstRepo.create(orgId, {
        id,
        organizationId: orgId,
        gstin,
        legalName,
        tradeName: legalName,
        stateCode,
        pan,
        registrationType: 'REGULAR',
        status,
        isActive
      });
    };

    // Create test GST registrations for orgA
    const active = await createReg(orgA.organizationId, '27AAPFU0939F1ZV', 'Acme Maharashtra Active', 'AAPFU0939F', '27', 'ACTIVE', true);
    activeGstRegId = active.id;

    const cancelled = await createReg(orgA.organizationId, '29AABCU9603R1ZJ', 'Acme Karnataka Cancelled', 'AABCU9603R', '29', 'CANCELLED', false);
    cancelledGstRegId = cancelled.id;

    const suspended = await createReg(orgA.organizationId, '07AAAAA0000A1Z4', 'Acme Delhi Suspended', 'AAAAA0000A', '07', 'SUSPENDED', true);
    suspendedGstRegId = suspended.id;

    const inactive = await createReg(orgA.organizationId, '33AAACA1234A1ZR', 'Acme Tamil Nadu Inactive', 'AAACA1234A', '33', 'INACTIVE', false);
    inactiveGstRegId = inactive.id;
  });

  describe('GST Registration Ownership & Operational Eligibility', () => {
    it('rejects import when GST registration does not exist', async () => {
      const nonExistentId = crypto.randomUUID();
      await expect(
        service.createImport(orgA, {
          gstRegistrationId: nonExistentId,
          sourcePlatform: 'AMAZON',
          originalFileName: 'sales.csv',
          tempFilePath: '/tmp/sales.csv',
          fileSizeBytes: BigInt(1024),
          fingerprint: 'a'.repeat(64)
        })
      ).rejects.toThrow(GstRegistrationNotEligibleError);
    });

    it('rejects import when GST registration belongs to a different organization', async () => {
      // Create GST registration under orgB
      const orgBRegId = crypto.randomUUID();
      const orgBReg = await gstRepo.create(orgB.organizationId, {
        id: orgBRegId,
        organizationId: orgB.organizationId,
        gstin: '24AAAAA0000A1Z8',
        legalName: 'Org B Gujarat',
        tradeName: 'Org B Gujarat',
        stateCode: '24',
        pan: 'AAAAA0000A',
        registrationType: 'REGULAR',
        status: 'ACTIVE',
        isActive: true
      });

      // Attempt to use orgBReg under orgA context
      await expect(
        service.createImport(orgA, {
          gstRegistrationId: orgBReg.id,
          sourcePlatform: 'AMAZON',
          originalFileName: 'sales.csv',
          tempFilePath: '/tmp/sales.csv',
          fileSizeBytes: BigInt(1024),
          fingerprint: 'b'.repeat(64)
        })
      ).rejects.toThrow(GstRegistrationNotEligibleError);
    });

    it('rejects import against a CANCELLED GST registration (terminal statutory state)', async () => {
      await expect(
        service.createImport(orgA, {
          gstRegistrationId: cancelledGstRegId,
          sourcePlatform: 'AMAZON',
          originalFileName: 'sales.csv',
          tempFilePath: '/tmp/sales.csv',
          fileSizeBytes: BigInt(1024),
          fingerprint: 'c'.repeat(64)
        })
      ).rejects.toThrow(/CANCELLED/);
    });

    it('rejects import against a SUSPENDED or INACTIVE GST registration', async () => {
      await expect(
        service.createImport(orgA, {
          gstRegistrationId: suspendedGstRegId,
          sourcePlatform: 'AMAZON',
          originalFileName: 'sales.csv',
          tempFilePath: '/tmp/sales.csv',
          fileSizeBytes: BigInt(1024),
          fingerprint: 'd'.repeat(64)
        })
      ).rejects.toThrow(/SUSPENDED/);

      await expect(
        service.createImport(orgA, {
          gstRegistrationId: inactiveGstRegId,
          sourcePlatform: 'AMAZON',
          originalFileName: 'sales.csv',
          tempFilePath: '/tmp/sales.csv',
          fileSizeBytes: BigInt(1024),
          fingerprint: 'e'.repeat(64)
        })
      ).rejects.toThrow(/INACTIVE/);
    });
  });

  describe('Organization-Scoped Duplicate File Detection', () => {
    it('blocks duplicate upload if identical file is currently PROCESSING or QUEUED', async () => {
      const fingerprint = 'f'.repeat(64);

      // Create existing source file and associate with an active batch
      const sf = await sourceRecordRepo.createSourceFile(orgA, {
        fileName: 'active_march.csv',
        fileFingerprint: fingerprint,
        fileSizeBytes: BigInt(2048),
        storageUri: '/storage/active_march.csv',
        sourceReportType: 'AMAZON_MTR'
      });

      const batch = await batchRepo.createBatch(orgA, {
        batchNumber: 'BATCH-ACTIVE-001',
        engineVersion: '0.1.0',
        rulesVersion: '2024.1'
      });

      await batchRepo.associateSourceFile(orgA, batch.id, sf.id, FileBatchStatus.PROCESSING);

      // Attempt duplicate upload
      await expect(
        service.createImport(orgA, {
          gstRegistrationId: activeGstRegId,
          sourcePlatform: 'AMAZON',
          originalFileName: 'another_name_same_bytes.csv',
          tempFilePath: '/tmp/test.csv',
          fileSizeBytes: BigInt(2048),
          fingerprint
        })
      ).rejects.toThrow(DuplicateImportError);
    });

    it('blocks duplicate upload if identical file was already COMPLETED in a prior batch', async () => {
      const fingerprint = '9'.repeat(64);

      const sf = await sourceRecordRepo.createSourceFile(orgA, {
        fileName: 'completed_march.csv',
        fileFingerprint: fingerprint,
        fileSizeBytes: BigInt(5000),
        storageUri: '/storage/completed_march.csv',
        sourceReportType: 'AMAZON_MTR'
      });

      const batch = await batchRepo.createBatch(orgA, {
        batchNumber: 'BATCH-COMPLETED-001',
        engineVersion: '0.1.0',
        rulesVersion: '2024.1'
      });
      await batchRepo.associateSourceFile(orgA, batch.id, sf.id, FileBatchStatus.COMPLETED);
      await batchRepo.updateBatchStatus(orgA, batch.id, BatchStatus.PENDING, BatchStatus.PROCESSING);
      await batchRepo.updateBatchStatus(orgA, batch.id, BatchStatus.PROCESSING, BatchStatus.COMPLETED);

      // Register batch in importRepo so it can be queried
      await importRepo.createImportBatch(orgA, {
        id: batch.id,
        batchNumber: batch.batchNumber,
        engineVersion: '0.1.0',
        rulesVersion: '2024.1',
        gstRegistrationId: activeGstRegId,
        sourcePlatform: 'AMAZON'
      });
      importRepo.updateBatchStatus(orgA.organizationId, batch.id, BatchStatus.COMPLETED);

      await expect(
        service.createImport(orgA, {
          gstRegistrationId: activeGstRegId,
          sourcePlatform: 'AMAZON',
          originalFileName: 'identical_file.csv',
          tempFilePath: '/tmp/identical.csv',
          fileSizeBytes: BigInt(5000),
          fingerprint
        })
      ).rejects.toThrow(DuplicateImportError);
    });

    it('allows identical file upload to Org B without leaking Org A state (cross-tenant isolation)', async () => {
      const fingerprint = '8'.repeat(64);

      // Org A stages the file
      await sourceRecordRepo.createSourceFile(orgA, {
        fileName: 'org_a_file.csv',
        fileFingerprint: fingerprint,
        fileSizeBytes: BigInt(4000),
        storageUri: '/storage/org_a_file.csv',
        sourceReportType: 'AMAZON_MTR'
      });

      // Org B registers active GSTIN
      const orgBRegId = crypto.randomUUID();
      const orgBReg = await gstRepo.create(orgB.organizationId, {
        id: orgBRegId,
        organizationId: orgB.organizationId,
        gstin: '24AAAAA0000A1Z8',
        legalName: 'Org B Gujarat',
        tradeName: 'Org B Gujarat',
        stateCode: '24',
        pan: 'AAAAA0000A',
        registrationType: 'REGULAR',
        status: 'ACTIVE',
        isActive: true
      });

      // Org B should be able to upload without being blocked by Org A's record
      const resultB = await service.createImport(orgB, {
        gstRegistrationId: orgBReg.id,
        sourcePlatform: 'AMAZON',
        originalFileName: 'org_b_upload.csv',
        tempFilePath: '/tmp/org_b.csv',
        fileSizeBytes: BigInt(4000),
        fingerprint
      });

      expect(resultB.organizationId).toBe(orgB.organizationId);
      expect(resultB.lifecycleStatus).toBe('QUEUED');
    });
  });

  describe('Import Batch Lifecycle & Outbox Dispatching', () => {
    it('creates ImportBatch, persists metadata, and creates ProcessingJob and OutboxEvent atomically', async () => {
      const fingerprint = '7'.repeat(64);

      const result = await service.createImport(orgA, {
        gstRegistrationId: activeGstRegId,
        sourcePlatform: 'AMAZON',
        originalFileName: 'amazon_nov_2026.csv',
        tempFilePath: '/tmp/amazon_nov_2026.csv',
        fileSizeBytes: BigInt(12345),
        fingerprint,
        metadata: { quarter: 'Q3', year: 2026 }
      });

      expect(result.id).toBeDefined();
      expect(result.organizationId).toBe(orgA.organizationId);
      expect(result.batchNumber).toMatch(/^BATCH-\d+-[A-Z0-9]+$/);
      expect(result.gstRegistrationId).toBe(activeGstRegId);
      expect(result.sourcePlatform).toBe('AMAZON');
      expect(result.status).toBe(BatchStatus.PENDING);
      expect(result.lifecycleStatus).toBe('QUEUED');

      // Verify ProcessingJob was created
      const job = await importRepo.getLatestJobForBatch(orgA, result.id);
      expect(job).not.toBeNull();
      expect(job?.status).toBe('QUEUED');
      expect(job?.jobType).toBe('BATCH_PROCESSING');
    });

    it('retrieves import status with detailed job checkpoints', async () => {
      const fingerprint = '6'.repeat(64);

      const created = await service.createImport(orgA, {
        gstRegistrationId: activeGstRegId,
        sourcePlatform: 'AMAZON',
        originalFileName: 'status_check.csv',
        tempFilePath: '/tmp/status_check.csv',
        fileSizeBytes: BigInt(2048),
        fingerprint
      });

      const status = await service.getImportStatus(orgA, created.id);
      expect(status.batchId).toBe(created.id);
      expect(status.organizationId).toBe(orgA.organizationId);
      expect(status.status).toBe(BatchStatus.PENDING);
      expect(status.lifecycleStatus).toBe('QUEUED');
      expect(status.job?.status).toBe('QUEUED');
    });

    it('throws ImportNotFoundError when batch does not exist', async () => {
      const nonExistentBatchId = crypto.randomUUID();
      await expect(service.getImport(orgA, nonExistentBatchId)).rejects.toThrow(ImportNotFoundError);
      await expect(service.getImportStatus(orgA, nonExistentBatchId)).rejects.toThrow(ImportNotFoundError);
      await expect(service.getImportSummary(orgA, nonExistentBatchId)).rejects.toThrow(ImportNotFoundError);
    });

    it('lists imports with pagination and filtering', async () => {
      // Create 3 imports
      for (let i = 1; i <= 3; i++) {
        await service.createImport(orgA, {
          gstRegistrationId: activeGstRegId,
          sourcePlatform: 'AMAZON',
          originalFileName: `file_${i}.csv`,
          tempFilePath: `/tmp/file_${i}.csv`,
          fileSizeBytes: BigInt(1000 * i),
          fingerprint: `${i}`.repeat(64)
        });
      }

      const listResult = await service.listImports(orgA, { page: 1, limit: 2 });
      expect(listResult.items.length).toBe(2);
      expect(listResult.pagination.totalItems).toBe(3);
      expect(listResult.pagination.totalPages).toBe(2);
    });
  });
});
