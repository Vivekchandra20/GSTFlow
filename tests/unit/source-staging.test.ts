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
  StagingExecutionError
} from '../../src/application/persistent-pipeline/index.js';
import { InMemorySourceRecordRepository } from '../../src/repositories/in-memory/in-memory-source-record.repository.js';
import { InMemoryImportBatchRepository } from '../../src/repositories/in-memory/in-memory-import-batch.repository.js';
import { TenantContext, FileBatchStatus, BatchStatus } from '../../src/repositories/types.js';

describe('Phase 3B.4.2: Source Staging Unit Tests', () => {
  let tempDir: string;
  let sourceRepo: InMemorySourceRecordRepository;
  let batchRepo: InMemoryImportBatchRepository;
  let stagingService: SourceStagingService;
  let orchestrator: PersistentPipelineOrchestrator;

  const validOrgId = 'a0000000-0000-4000-8000-000000000001';
  const tenantCtx: TenantContext = { organizationId: validOrgId };

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstflow-staging-test-'));
  });

  afterAll(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    sourceRepo = new InMemorySourceRecordRepository();
    batchRepo = new InMemoryImportBatchRepository();
    stagingService = new SourceStagingService({
      sourceRecordRepo: sourceRepo,
      batchRepo,
      defaultChunkSize: 5,
      allowedUploadDir: tempDir
    });
    orchestrator = new PersistentPipelineOrchestrator({
      importBatchRepo: batchRepo,
      sourceRecordRepo: sourceRepo,
      stagingChunkSize: 5,
      allowedUploadDir: tempDir
    });
  });

  describe('1. SHA-256 Fingerprint Correctness & Deduplication', () => {
    it('computes correct SHA-256 hex fingerprint from file stream', async () => {
      const filePath = path.join(tempDir, 'sample-1.csv');
      const content = 'Invoice Number,Amount\nINV-001,1000\n';
      fs.writeFileSync(filePath, content, 'utf8');

      const expectedHash = crypto.createHash('sha256').update(content).digest('hex');
      const { fingerprint, fileSizeBytes } = await stagingService.computeFileFingerprint(filePath);

      expect(fingerprint).toBe(expectedHash);
      expect(fileSizeBytes).toBe(BigInt(Buffer.byteLength(content)));
    });

    it('detects identical files with matching fingerprints', async () => {
      const file1 = path.join(tempDir, 'file-a.csv');
      const file2 = path.join(tempDir, 'file-b.csv');
      const content = 'Order ID,SKU,Taxable Value\nORD-100,SKU-A,500.00\n';
      fs.writeFileSync(file1, content, 'utf8');
      fs.writeFileSync(file2, content, 'utf8');

      const hash1 = (await stagingService.computeFileFingerprint(file1)).fingerprint;
      const hash2 = (await stagingService.computeFileFingerprint(file2)).fingerprint;

      expect(hash1).toBe(hash2);
    });

    it('detects differing files with unique fingerprints', async () => {
      const file1 = path.join(tempDir, 'file-diff-1.csv');
      const file2 = path.join(tempDir, 'file-diff-2.csv');
      fs.writeFileSync(file1, 'Invoice Number\nINV-1\n', 'utf8');
      fs.writeFileSync(file2, 'Invoice Number\nINV-2\n', 'utf8');

      const hash1 = (await stagingService.computeFileFingerprint(file1)).fingerprint;
      const hash2 = (await stagingService.computeFileFingerprint(file2)).fingerprint;

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('2. File Path Security & Validation', () => {
    it('rejects non-existent file paths', () => {
      const nonExistent = path.join(tempDir, 'does-not-exist.csv');
      expect(() => stagingService.validateFilePath(nonExistent)).toThrow(
        SourceFileNotFoundOrInaccessibleError
      );
    });

    it('blocks directory traversal attempts outside allowedUploadDir', () => {
      const outsidePath = path.resolve(__dirname, '../fixtures/sample.csv');
      expect(() => stagingService.validateFilePath(outsidePath, tempDir)).toThrow(
        SourceFileNotFoundOrInaccessibleError
      );
    });

    it('rejects directory paths that are not regular files', () => {
      expect(() => stagingService.validateFilePath(tempDir)).toThrow(
        SourceFileNotFoundOrInaccessibleError
      );
    });
  });

  describe('3. CSV Ingestion Semantics & Integrity', () => {
    it('handles empty files (0 bytes) safely with 0 lines and COMPLETED status', async () => {
      const emptyFile = path.join(tempDir, 'empty.csv');
      fs.writeFileSync(emptyFile, '', 'utf8');

      const batch = await batchRepo.createBatch(tenantCtx, {
        batchNumber: 'BATCH-EMPTY-001',
        engineVersion: '0.1.0',
        rulesVersion: '2024.1'
      });

      const result = await stagingService.stageFile(tenantCtx, batch.id, emptyFile);

      expect(result.fileStatus).toBe(FileBatchStatus.COMPLETED);
      expect(result.recordsInserted).toBe(0);
      expect(result.totalPhysicalLines).toBe(0);
      expect(result.fileSizeBytes).toBe(BigInt(0));
    });

    it('preserves quoted fields, escaped quotes, and commas within quotes', async () => {
      const quotedFile = path.join(tempDir, 'quoted.csv');
      const content = `Invoice Number,Buyer Name,Description\nINV-001,"Acme, Inc.","Special ""Deluxe"" Widget"\n`;
      fs.writeFileSync(quotedFile, content, 'utf8');

      const batch = await batchRepo.createBatch(tenantCtx, {
        batchNumber: 'BATCH-QUOTED-001',
        engineVersion: '0.1.0',
        rulesVersion: '2024.1'
      });

      const result = await stagingService.stageFile(tenantCtx, batch.id, quotedFile);
      expect(result.recordsInserted).toBe(1);

      const records = await sourceRepo.findRecordsBySourceFile(tenantCtx, result.sourceFileId);
      expect(records.length).toBe(1);
      expect(records[0].rawPayload['Buyer Name']).toBe('Acme, Inc.');
      expect(records[0].rawPayload['Description']).toBe('Special "Deluxe" Widget');
    });

    it('handles multiline quoted fields and accurately tracks physical line numbers', async () => {
      const multilineFile = path.join(tempDir, 'multiline.csv');
      // Line 1: Header
      // Lines 2-4: Record 1 (spans 3 physical lines)
      // Line 5: Record 2 (single line)
      const content = `Invoice Number,Notes\nINV-001,"Line 1 of note\nLine 2 of note\nLine 3 of note"\nINV-002,"Single line note"\n`;
      fs.writeFileSync(multilineFile, content, 'utf8');

      const batch = await batchRepo.createBatch(tenantCtx, {
        batchNumber: 'BATCH-MULTILINE-001',
        engineVersion: '0.1.0',
        rulesVersion: '2024.1'
      });

      const result = await stagingService.stageFile(tenantCtx, batch.id, multilineFile);
      expect(result.recordsInserted).toBe(2);

      const records = await sourceRepo.findRecordsBySourceFile(tenantCtx, result.sourceFileId);
      expect(records.length).toBe(2);

      // Record 1 ends on physical line 4
      expect(records[0].logicalRecordNumber).toBe(1);
      expect(records[0].physicalLineNumber).toBe(4);
      expect(records[0].rawPayload['Notes']).toBe('Line 1 of note\nLine 2 of note\nLine 3 of note');

      // Record 2 is on physical line 5
      expect(records[1].logicalRecordNumber).toBe(2);
      expect(records[1].physicalLineNumber).toBe(5);
      expect(records[1].rawPayload['Invoice Number']).toBe('INV-002');

      expect(result.totalPhysicalLines).toBe(5);
    });

    it('preserves raw source values and original headers byte-for-byte without GST normalization', async () => {
      const rawFile = path.join(tempDir, 'raw-headers.csv');
      const content = `Custom_Header_1,Total Taxable,Raw Negative Amount,TCS %\nVAL_ABC,1234.56,-99.00,0.5%\n`;
      fs.writeFileSync(rawFile, content, 'utf8');

      const batch = await batchRepo.createBatch(tenantCtx, {
        batchNumber: 'BATCH-RAW-001',
        engineVersion: '0.1.0',
        rulesVersion: '2024.1'
      });

      const result = await stagingService.stageFile(tenantCtx, batch.id, rawFile);
      const records = await sourceRepo.findRecordsBySourceFile(tenantCtx, result.sourceFileId);

      expect(records[0].rawPayload['Custom_Header_1']).toBe('VAL_ABC');
      expect(records[0].rawPayload['Total Taxable']).toBe('1234.56');
      expect(records[0].rawPayload['Raw Negative Amount']).toBe('-99.00');
      expect(records[0].rawPayload['TCS %']).toBe('0.5%');
    });

    it('correctly stages records across chunk boundaries (12 records with chunk size 5)', async () => {
      const chunkFile = path.join(tempDir, 'chunked.csv');
      let lines = 'Invoice Number,Amount\n';
      for (let i = 1; i <= 12; i++) {
        lines += `INV-${i.toString().padStart(3, '0')},${i * 100}\n`;
      }
      fs.writeFileSync(chunkFile, lines, 'utf8');

      const batch = await batchRepo.createBatch(tenantCtx, {
        batchNumber: 'BATCH-CHUNK-001',
        engineVersion: '0.1.0',
        rulesVersion: '2024.1'
      });

      const result = await stagingService.stageFile(tenantCtx, batch.id, chunkFile, { chunkSize: 5 });

      expect(result.recordsInserted).toBe(12);
      expect(result.fileStatus).toBe(FileBatchStatus.COMPLETED);

      const count = await sourceRepo.countRecordsBySourceFile(tenantCtx, result.sourceFileId);
      expect(count).toBe(12);
    });

    it('cleans up resources and marks BatchSourceFile as FAILED when streaming parse fails', async () => {
      const corruptFile = path.join(tempDir, 'corrupt.csv');
      // Create malformed CSV with unclosed quote
      fs.writeFileSync(corruptFile, 'H1,H2\nVAL1,"Unclosed quote string without ending\n', 'utf8');

      const batch = await batchRepo.createBatch(tenantCtx, {
        batchNumber: 'BATCH-CORRUPT-001',
        engineVersion: '0.1.0',
        rulesVersion: '2024.1'
      });

      await expect(
        stagingService.stageFile(tenantCtx, batch.id, corruptFile)
      ).rejects.toThrow(FileCorruptedOrMalformedError);

      const batchWithFiles = await batchRepo.getBatchById(tenantCtx, batch.id);
      expect(batchWithFiles?.fileAssociations.length).toBe(1);
      expect(batchWithFiles?.fileAssociations[0].fileStatus).toBe(FileBatchStatus.FAILED);
      expect(batchWithFiles?.fileAssociations[0].errorSummary).toBeDefined();
    });
  });

  describe('4. Duplicate File Upload Outcomes', () => {
    it('detects duplicate uploads, reuses existing sourceFile, and inserts 0 duplicate records', async () => {
      const file = path.join(tempDir, 'dedupe-test.csv');
      fs.writeFileSync(file, 'Invoice Number,Amount\nINV-D1,500\nINV-D2,600\n', 'utf8');

      const batch1 = await batchRepo.createBatch(tenantCtx, {
        batchNumber: 'BATCH-DEDUP-001',
        engineVersion: '0.1.0',
        rulesVersion: '2024.1'
      });

      // Upload 1: New file
      const result1 = await stagingService.stageFile(tenantCtx, batch1.id, file);
      expect(result1.isDuplicate).toBe(false);
      expect(result1.reusedExisting).toBe(false);
      expect(result1.recordsInserted).toBe(2);

      const batch2 = await batchRepo.createBatch(tenantCtx, {
        batchNumber: 'BATCH-DEDUP-002',
        engineVersion: '0.1.0',
        rulesVersion: '2024.1'
      });

      // Upload 2: Same physical file in a new batch
      const result2 = await stagingService.stageFile(tenantCtx, batch2.id, file);
      expect(result2.isDuplicate).toBe(true);
      expect(result2.reusedExisting).toBe(true);
      expect(result2.sourceFileId).toBe(result1.sourceFileId);
      expect(result2.recordsInserted).toBe(0);

      // Verify that total records for sourceFileId remains exactly 2 (zero duplicates)
      const totalCount = await sourceRepo.countRecordsBySourceFile(tenantCtx, result1.sourceFileId);
      expect(totalCount).toBe(2);
    });
  });

  describe('5. Orchestrator stageBatch Coordination', () => {
    it('orchestrates end-to-end source staging leaving batch in PROCESSING state', async () => {
      const file = path.join(tempDir, 'orch-stage.csv');
      fs.writeFileSync(file, 'Invoice Number,Taxable\nINV-ORCH-1,100\nINV-ORCH-2,200\n', 'utf8');

      const stagingResult = await orchestrator.stageBatch(tenantCtx, {
        engineVersion: '0.1.0',
        rulesVersion: '2024.1',
        filePaths: [file]
      });

      expect(stagingResult.success).toBe(true);
      expect(stagingResult.totalRecordsInserted).toBe(2);
      expect(stagingResult.filesStaged.length).toBe(1);
      expect(stagingResult.filesStaged[0].fileStatus).toBe(FileBatchStatus.COMPLETED);

      // Crucial: ImportBatch remains in PROCESSING awaiting domain execution
      expect(stagingResult.batch.status).toBe(BatchStatus.PROCESSING);
      expect(stagingResult.batch.completedAt).toBeNull();
    });

    it('marks ImportBatch as FAILED if staging throws', async () => {
      const corruptFile = path.join(tempDir, 'orch-fail.csv');
      fs.writeFileSync(corruptFile, 'H1,H2\nVAL1,"Unclosed quote string\n', 'utf8');

      await expect(
        orchestrator.stageBatch(tenantCtx, {
          engineVersion: '0.1.0',
          rulesVersion: '2024.1',
          filePaths: [corruptFile]
        })
      ).rejects.toThrow(FileCorruptedOrMalformedError);
    });
  });
});
