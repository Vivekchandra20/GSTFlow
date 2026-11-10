import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  SourceStagingService,
  PersistentPipelineOrchestrator,
  SourceFileNotFoundOrInaccessibleError,
  FileCorruptedOrMalformedError,
  ConcurrentStagingError,
  BatchLifecycleError
} from '../../src/application/persistent-pipeline/index.js';
import { InMemorySourceRecordRepository } from '../../src/repositories/in-memory/in-memory-source-record.repository.js';
import { InMemoryImportBatchRepository } from '../../src/repositories/in-memory/in-memory-import-batch.repository.js';
import { TenantContext, FileBatchStatus, BatchStatus } from '../../src/repositories/types.js';

describe('Phase 3B.4.2-H: Source Staging Hardening & Integrity Suite', () => {
  let tempBaseDir: string;
  let allowedUploadDir: string;
  let outsideDir: string;
  let similarPrefixDir: string;

  let sourceRepo: InMemorySourceRecordRepository;
  let batchRepo: InMemoryImportBatchRepository;
  let stagingService: SourceStagingService;
  let orchestrator: PersistentPipelineOrchestrator;

  const tenantCtx: TenantContext = { organizationId: 'a0000000-0000-4000-8000-000000000001' };

  beforeAll(() => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstflow-hardening-'));
    allowedUploadDir = path.join(tempBaseDir, 'uploads');
    outsideDir = path.join(tempBaseDir, 'outside');
    similarPrefixDir = path.join(tempBaseDir, 'uploads_private');

    fs.mkdirSync(allowedUploadDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.mkdirSync(similarPrefixDir, { recursive: true });
  });

  afterAll(() => {
    if (fs.existsSync(tempBaseDir)) {
      fs.rmSync(tempBaseDir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    sourceRepo = new InMemorySourceRecordRepository();
    batchRepo = new InMemoryImportBatchRepository();
    stagingService = new SourceStagingService({
      sourceRecordRepo: sourceRepo,
      batchRepo,
      defaultChunkSize: 5,
      allowedUploadDir,
      storageBaseDir: path.join(tempBaseDir, 'cas_storage')
    });
    orchestrator = new PersistentPipelineOrchestrator({
      importBatchRepo: batchRepo,
      sourceRecordRepo: sourceRepo,
      stagingChunkSize: 5,
      allowedUploadDir,
      storageBaseDir: path.join(tempBaseDir, 'cas_storage')
    });
  });

  describe('Critical Issue B: Filesystem Path Security & Traversal Boundary Enforcement', () => {
    it('1. Blocks prefix collision attack (e.g. /uploads_private vs /uploads)', () => {
      const collisionFile = path.join(similarPrefixDir, 'secret.csv');
      fs.writeFileSync(collisionFile, 'A,B\n1,2\n', 'utf8');

      expect(() => stagingService.validateFilePath(collisionFile)).toThrow(
        SourceFileNotFoundOrInaccessibleError
      );
    });

    it('2. Blocks ../ parent traversal attempts', () => {
      const targetFile = path.join(outsideDir, 'external.csv');
      fs.writeFileSync(targetFile, 'A,B\n1,2\n', 'utf8');

      const traversalPath = path.join(allowedUploadDir, '../outside/external.csv');
      expect(() => stagingService.validateFilePath(traversalPath)).toThrow(
        SourceFileNotFoundOrInaccessibleError
      );
    });

    it('3. Rejects directory paths passed as files', () => {
      expect(() => stagingService.validateFilePath(allowedUploadDir)).toThrow(
        SourceFileNotFoundOrInaccessibleError
      );
    });

    it('4. Rejects non-existent files', () => {
      const nonExistent = path.join(allowedUploadDir, 'ghost.csv');
      expect(() => stagingService.validateFilePath(nonExistent)).toThrow(
        SourceFileNotFoundOrInaccessibleError
      );
    });

    it('5. Blocks symlink escaping the permitted boundary', () => {
      const externalTarget = path.join(outsideDir, 'sensitive.csv');
      fs.writeFileSync(externalTarget, 'SECRET,DATA\nKEY,VAL\n', 'utf8');

      const symlinkPath = path.join(allowedUploadDir, 'escape_link.csv');
      try {
        fs.symlinkSync(externalTarget, symlinkPath, 'file');
        expect(() => stagingService.validateFilePath(symlinkPath)).toThrow(
          SourceFileNotFoundOrInaccessibleError
        );
      } catch (err: any) {
        // On Windows without Developer Mode, creating symlinks may require elevated privileges
        if (err.code !== 'EPERM') {
          throw err;
        }
      }
    });

    it('6. openSecureFile safely returns open handle and stat for valid files', async () => {
      const validFile = path.join(allowedUploadDir, 'valid.csv');
      fs.writeFileSync(validFile, 'H1,H2\nV1,V2\n', 'utf8');

      const secure = await stagingService.openSecureFile(validFile);
      expect(secure.fileHandle).toBeDefined();
      expect(secure.canonicalPath).toBe(fs.realpathSync(validFile));
      expect(secure.initialStat.isFile()).toBe(true);

      await secure.fileHandle.close();
    });
  });

  describe('Critical Issue C: Hashing and Parsing Integrity & Mutation Detection', () => {
    it('7. Detects file mutation during ingestion and rejects without committing', async () => {
      const fileToMutate = path.join(allowedUploadDir, 'mutate_during_staging.csv');
      fs.writeFileSync(fileToMutate, 'Header1,Header2\nValue1,Value2\n', 'utf8');

      // Create a batch
      const batch = await batchRepo.createBatch(tenantCtx, {
        batchNumber: 'BATCH-MUTATE-001',
        engineVersion: '0.1.0',
        rulesVersion: '2024.1'
      });

      // Securely spy or simulate postStat modification to test the mutation guard
      const originalOpen = stagingService.openSecureFile.bind(stagingService);
      stagingService.openSecureFile = async (fp, dir) => {
        const secure = await originalOpen(fp, dir);
        const originalStat = secure.fileHandle.stat.bind(secure.fileHandle);
        secure.fileHandle.stat = async () => {
          const s = await originalStat();
          // Simulate that post-read check observes on-disk file mutation
          return Object.assign(Object.create(Object.getPrototypeOf(s)), s, {
            mtimeMs: s.mtimeMs + 5000,
            size: s.size + 100
          });
        };
        return secure;
      };

      await expect(
        stagingService.stageFile(tenantCtx, batch.id, fileToMutate)
      ).rejects.toThrow(FileCorruptedOrMalformedError);

      // Verify batch association reflects FAILED
      const batchFiles = await batchRepo.findBatchSourceFilesBySourceFile(tenantCtx, batch.id);
      expect(batchFiles.length).toBe(0); // Never committed as completed
    });
  });

  describe('Critical Issue A: Incomplete File Deduplication & Lifecycle States', () => {
    it('8. Does not treat an incomplete or failed source file as completed; resumes and retries staging', async () => {
      const filePath = path.join(allowedUploadDir, 'incomplete.csv');
      fs.writeFileSync(filePath, 'Col1,Col2\nRow1,Val1\nRow2,Val2\nRow3,Val3\n', 'utf8');

      const { fingerprint, fileSizeBytes } = await stagingService.computeFileFingerprint(filePath);

      // Simulate a previously interrupted staging:
      // SourceFile was created, but totalPhysicalLines is 0 and only 1 row was inserted
      const incompleteFile = await sourceRepo.createSourceFile(tenantCtx, {
        fileName: 'incomplete.csv',
        fileFingerprint: fingerprint,
        fileSizeBytes,
        storageUri: filePath,
        sourceReportType: 'UNKNOWN',
        totalPhysicalLines: 0 // Incomplete!
      });

      await sourceRepo.bulkInsertSourceRecords(tenantCtx, incompleteFile.id, [
        {
          physicalLineNumber: 2,
          logicalRecordNumber: 1,
          recordType: 'OUTWARD_SUPPLY' as any,
          rawPayload: { Col1: 'Row1', Col2: 'Val1' }
        }
      ]);

      const failedBatch = await batchRepo.createBatch(tenantCtx, {
        batchNumber: 'BATCH-FAILED-PREV',
        engineVersion: '0.1.0',
        rulesVersion: '2024.1'
      });
      await batchRepo.associateSourceFile(tenantCtx, failedBatch.id, incompleteFile.id, FileBatchStatus.FAILED);

      // Now stage the identical file into a NEW batch
      const newBatch = await batchRepo.createBatch(tenantCtx, {
        batchNumber: 'BATCH-RETRY-001',
        engineVersion: '0.1.0',
        rulesVersion: '2024.1'
      });

      const result = await stagingService.stageFile(tenantCtx, newBatch.id, filePath);

      // Staging must NOT assume duplicate complete! It must resume and complete!
      expect(result.fileStatus).toBe(FileBatchStatus.COMPLETED);
      expect(result.totalPhysicalLines).toBe(4); // 1 header + 3 data rows
      expect(result.recordsInserted).toBe(2); // 1 was already there, 2 newly inserted
      expect(result.recordsSkipped).toBe(1); // 1 skipped via ON CONFLICT DO NOTHING

      // Total records in DB must now be 3
      const totalInDb = await sourceRepo.countRecordsBySourceFile(tenantCtx, incompleteFile.id);
      expect(totalInDb).toBe(3);

      // Updated SourceFile must have totalPhysicalLines > 0
      const updatedFile = await sourceRepo.findSourceFileById(tenantCtx, incompleteFile.id);
      expect(updatedFile?.totalPhysicalLines).toBe(4);
    });

    it('9. Completed file reuse skips all records and queries exact count from DB', async () => {
      const filePath = path.join(allowedUploadDir, 'complete_dup.csv');
      fs.writeFileSync(filePath, 'ColA,ColB\nValA1,ValB1\nValA2,ValB2\n', 'utf8');

      const batch1 = await batchRepo.createBatch(tenantCtx, {
        batchNumber: 'BATCH-ORIGINAL-001',
        engineVersion: '0.1.0',
        rulesVersion: '2024.1'
      });

      const res1 = await stagingService.stageFile(tenantCtx, batch1.id, filePath);
      expect(res1.fileStatus).toBe(FileBatchStatus.COMPLETED);
      expect(res1.recordsInserted).toBe(2);
      expect(res1.recordsSkipped).toBe(0);

      // Second upload into batch2
      const batch2 = await batchRepo.createBatch(tenantCtx, {
        batchNumber: 'BATCH-SECOND-002',
        engineVersion: '0.1.0',
        rulesVersion: '2024.1'
      });

      const res2 = await stagingService.stageFile(tenantCtx, batch2.id, filePath);
      expect(res2.isDuplicate).toBe(true);
      expect(res2.reusedExisting).toBe(true);
      expect(res2.fileStatus).toBe(FileBatchStatus.COMPLETED);
      expect(res2.recordsInserted).toBe(0);
      expect(res2.recordsSkipped).toBe(2); // Exactly 2 records in DB
      expect(res2.parsedLogicalRecords).toBe(2);
    });

    it('10. Concurrent active staging in another batch throws ConcurrentStagingError', async () => {
      const filePath = path.join(allowedUploadDir, 'concurrent_file.csv');
      fs.writeFileSync(filePath, 'ColA,ColB\n1,2\n', 'utf8');

      const { fingerprint, fileSizeBytes } = await stagingService.computeFileFingerprint(filePath);

      const activeFile = await sourceRepo.createSourceFile(tenantCtx, {
        fileName: 'concurrent_file.csv',
        fileFingerprint: fingerprint,
        fileSizeBytes,
        storageUri: filePath,
        sourceReportType: 'UNKNOWN',
        totalPhysicalLines: 0
      });

      const activeBatch = await batchRepo.createBatch(tenantCtx, {
        batchNumber: 'BATCH-ACTIVE-001',
        engineVersion: '0.1.0',
        rulesVersion: '2024.1'
      });
      // Mark as PROCESSING in active batch
      await batchRepo.associateSourceFile(tenantCtx, activeBatch.id, activeFile.id, FileBatchStatus.PROCESSING);

      // Second worker in competing batch tries to stage the same file
      const competingBatch = await batchRepo.createBatch(tenantCtx, {
        batchNumber: 'BATCH-COMPETING-002',
        engineVersion: '0.1.0',
        rulesVersion: '2024.1'
      });

      await expect(
        stagingService.stageFile(tenantCtx, competingBatch.id, filePath)
      ).rejects.toThrow(ConcurrentStagingError);
    });
  });

  describe('Critical Issue E: Batch Lifecycle Integrity', () => {
    it('11. Rejects staging into COMPLETED or FAILED batch', async () => {
      const filePath = path.join(allowedUploadDir, 'sample_lifecycle.csv');
      fs.writeFileSync(filePath, 'Col1,Col2\n1,2\n', 'utf8');

      // 1. COMPLETED batch
      const completedBatch = await batchRepo.createBatch(tenantCtx, {
        batchNumber: 'BATCH-LIFECYCLE-DONE',
        engineVersion: '0.1.0',
        rulesVersion: '2024.1'
      });
      await batchRepo.updateBatchStatus(tenantCtx, completedBatch.id, BatchStatus.PENDING, BatchStatus.PROCESSING);
      await batchRepo.updateBatchStatus(tenantCtx, completedBatch.id, BatchStatus.PROCESSING, BatchStatus.COMPLETED);

      await expect(
        orchestrator.stageBatch(tenantCtx, {
          batchId: completedBatch.id,
          filePaths: [filePath]
        })
      ).rejects.toThrow(BatchLifecycleError);

      // 2. FAILED batch
      const failedBatch = await batchRepo.createBatch(tenantCtx, {
        batchNumber: 'BATCH-LIFECYCLE-FAIL',
        engineVersion: '0.1.0',
        rulesVersion: '2024.1'
      });
      await batchRepo.updateBatchStatus(tenantCtx, failedBatch.id, BatchStatus.PENDING, BatchStatus.FAILED);

      await expect(
        orchestrator.stageBatch(tenantCtx, {
          batchId: failedBatch.id,
          filePaths: [filePath]
        })
      ).rejects.toThrow(BatchLifecycleError);
    });

    it('12. Rejects runBatch when batchNumber matches a completed or failed batch', async () => {
      const filePath = path.join(allowedUploadDir, 'sample_run.csv');
      fs.writeFileSync(filePath, 'Col1,Col2\n1,2\n', 'utf8');

      const batch = await batchRepo.createBatch(tenantCtx, {
        batchNumber: 'BATCH-LIFECYCLE-REUSE',
        engineVersion: '0.1.0',
        rulesVersion: '2024.1'
      });
      await batchRepo.updateBatchStatus(tenantCtx, batch.id, BatchStatus.PENDING, BatchStatus.PROCESSING);
      await batchRepo.updateBatchStatus(tenantCtx, batch.id, BatchStatus.PROCESSING, BatchStatus.COMPLETED);

      await expect(
        orchestrator.runBatch(tenantCtx, {
          batchNumber: 'BATCH-LIFECYCLE-REUSE',
          engineVersion: '0.1.0',
          rulesVersion: '2024.1',
          filePaths: [filePath]
        })
      ).rejects.toThrow(BatchLifecycleError);
    });
  });

  describe('Critical Issue F: Record Count Accuracy with Multiline & Quoted Records', () => {
    it('13. Accurately tracks physical lines vs logical records for multiline CSV rows', async () => {
      const multilineFile = path.join(allowedUploadDir, 'multiline_address.csv');
      // 1 header + 2 records, but Record 1 spans 3 physical lines because of embedded newlines in address
      const csvContent =
        'Invoice Number,Address,Amount\n' +
        'INV-100,"Flat 402,\nTower B, Galaxy Apartments,\nBangalore",1500.00\n' +
        'INV-101,"Suite 10, Mumbai",2500.00\n';

      fs.writeFileSync(multilineFile, csvContent, 'utf8');

      const batch = await batchRepo.createBatch(tenantCtx, {
        batchNumber: 'BATCH-MULTILINE-001',
        engineVersion: '0.1.0',
        rulesVersion: '2024.1'
      });

      const result = await stagingService.stageFile(tenantCtx, batch.id, multilineFile);

      // Physical line count must be 5:
      // Line 1: Header
      // Line 2: INV-100,"Flat 402,
      // Line 3: Tower B, Galaxy Apartments,
      // Line 4: Bangalore",1500.00
      // Line 5: INV-101,"Suite 10, Mumbai",2500.00
      expect(result.totalPhysicalLines).toBe(5);
      expect(result.headerLines).toBe(1);
      expect(result.parsedLogicalRecords).toBe(2); // Exactly 2 records, NOT 5 - 1 = 4!
      expect(result.totalDataRecords).toBe(2);
      expect(result.recordsInserted).toBe(2);
      expect(result.recordsSkipped).toBe(0);
      expect(result.recordsRejected).toBe(0);

      // Verify the stored raw payload preserved the multiline field intact
      const records = await sourceRepo.findRecordsBySourceFile(tenantCtx, result.sourceFileId);
      expect(records.length).toBe(2);
      expect(records[0].rawPayload['Address']).toBe('Flat 402,\nTower B, Galaxy Apartments,\nBangalore');
      expect(records[0].physicalLineNumber).toBe(4); // Finished on physical line 4
      expect(records[1].physicalLineNumber).toBe(5);
    });

    it('14. Correctly handles blank lines and escaped quotes', async () => {
      const complexFile = path.join(allowedUploadDir, 'escaped_quotes.csv');
      const csvContent =
        'SKU,Description,Price\n' +
        'SKU-1,"14"" Laptop with \\"anti-glare\\" screen",50000\n' +
        '\n' + // Blank line
        'SKU-2,"USB-C Cable",500\n';

      fs.writeFileSync(complexFile, csvContent, 'utf8');

      const batch = await batchRepo.createBatch(tenantCtx, {
        batchNumber: 'BATCH-ESCAPED-001',
        engineVersion: '0.1.0',
        rulesVersion: '2024.1'
      });

      const result = await stagingService.stageFile(tenantCtx, batch.id, complexFile);

      expect(result.parsedLogicalRecords).toBe(2);
      expect(result.totalDataRecords).toBe(2);
      expect(result.recordsInserted).toBe(2);
    });
  });
});
