import { describe, it, expect, beforeEach } from 'vitest';
import {
  PersistentPipelineOrchestrator,
  TenantContextInvalidError,
  InvalidBatchInputError,
  DomainPipelineExecutionError,
  RunPersistentBatchInput
} from '../../src/application/persistent-pipeline/index.js';
import { InMemoryImportBatchRepository } from '../../src/repositories/in-memory/in-memory-import-batch.repository.js';
import { InMemoryTransactionManager } from '../../src/repositories/in-memory/in-memory-transaction-manager.js';
import { PipelineOrchestrator } from '../../src/pipeline/pipeline-orchestrator.js';
import { BatchStatus, TenantContext } from '../../src/repositories/types.js';
import path from 'path';

describe('PersistentPipelineOrchestrator - Unit Tests', () => {
  const validOrgId = 'a0000000-0000-4000-8000-000000000001';
  const tenantCtx: TenantContext = { organizationId: validOrgId };

  let batchRepo: InMemoryImportBatchRepository;
  let txManager: InMemoryTransactionManager;
  let orchestrator: PersistentPipelineOrchestrator;

  // Path to synthetic sample fixture
  const sampleFilePath = path.resolve(
    __dirname,
    '../../GSTFlow_Synthetic_Test_Suite/amazon/synthetic_amazon_mtr_b2b.csv'
  );

  beforeEach(() => {
    batchRepo = new InMemoryImportBatchRepository();
    txManager = new InMemoryTransactionManager();
    orchestrator = new PersistentPipelineOrchestrator({
      importBatchRepo: batchRepo,
      transactionManager: txManager
    });
  });

  describe('1. Construction & Dependency Injection', () => {
    it('throws an error if importBatchRepo dependency is missing', () => {
      expect(() => new PersistentPipelineOrchestrator({} as any)).toThrow(
        'PersistentPipelineOrchestrator requires an importBatchRepo dependency.'
      );
    });

    it('correctly initializes with provided dependencies and getters', () => {
      const customPipeline = new PipelineOrchestrator();
      const customOrchestrator = new PersistentPipelineOrchestrator({
        importBatchRepo: batchRepo,
        pipelineOrchestrator: customPipeline,
        transactionManager: txManager
      });

      expect(customOrchestrator.getImportBatchRepository()).toBe(batchRepo);
      expect(customOrchestrator.getPipelineOrchestrator()).toBe(customPipeline);
      expect(customOrchestrator.getTransactionManager()).toBe(txManager);
    });
  });

  describe('2. Tenant Context Validation', () => {
    const defaultInput: RunPersistentBatchInput = {
      engineVersion: '0.1.0',
      rulesVersion: '2024.1',
      filePaths: [sampleFilePath]
    };

    it('rejects missing or null tenant context', async () => {
      await expect(orchestrator.runBatch(null as any, defaultInput)).rejects.toThrow(
        TenantContextInvalidError
      );
    });

    it('rejects invalid or non-UUID organization IDs', async () => {
      const invalidCtx: TenantContext = { organizationId: 'not-a-uuid-123' };
      await expect(orchestrator.runBatch(invalidCtx, defaultInput)).rejects.toThrow(
        TenantContextInvalidError
      );
    });

    it('rejects empty organization ID string', async () => {
      const invalidCtx: TenantContext = { organizationId: '' };
      await expect(orchestrator.runBatch(invalidCtx, defaultInput)).rejects.toThrow(
        TenantContextInvalidError
      );
    });
  });

  describe('3. Batch Input Validation', () => {
    it('rejects missing or empty engineVersion', async () => {
      const input: RunPersistentBatchInput = {
        engineVersion: '',
        rulesVersion: '2024.1',
        filePaths: [sampleFilePath]
      };
      await expect(orchestrator.runBatch(tenantCtx, input)).rejects.toThrow(InvalidBatchInputError);
    });

    it('rejects missing or empty rulesVersion', async () => {
      const input: RunPersistentBatchInput = {
        engineVersion: '0.1.0',
        rulesVersion: '   ',
        filePaths: [sampleFilePath]
      };
      await expect(orchestrator.runBatch(tenantCtx, input)).rejects.toThrow(InvalidBatchInputError);
    });

    it('rejects empty filePaths array', async () => {
      const input: RunPersistentBatchInput = {
        engineVersion: '0.1.0',
        rulesVersion: '2024.1',
        filePaths: []
      };
      await expect(orchestrator.runBatch(tenantCtx, input)).rejects.toThrow(InvalidBatchInputError);
    });

    it('rejects filePaths containing empty string elements', async () => {
      const input: RunPersistentBatchInput = {
        engineVersion: '0.1.0',
        rulesVersion: '2024.1',
        filePaths: ['']
      };
      await expect(orchestrator.runBatch(tenantCtx, input)).rejects.toThrow(InvalidBatchInputError);
    });
  });

  describe('4. Batch Lifecycle & Successful Execution', () => {
    it('transitions batch from PENDING -> PROCESSING -> COMPLETED', async () => {
      const input: RunPersistentBatchInput = {
        batchNumber: 'BATCH-TEST-SUCCESS-001',
        engineVersion: '0.1.0',
        rulesVersion: '2024.1',
        filePaths: [sampleFilePath]
      };

      const result = await orchestrator.runBatch(tenantCtx, input);

      expect(result.success).toBe(true);
      expect(result.batch.batchNumber).toBe('BATCH-TEST-SUCCESS-001');
      expect(result.batch.status).toBe(BatchStatus.COMPLETED);
      expect(result.batch.completedAt).toBeInstanceOf(Date);
      expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.report).toBeDefined();

      // Verify the persisted record in repository
      const persisted = await batchRepo.getBatchById(tenantCtx, result.batch.id);
      expect(persisted).not.toBeNull();
      expect(persisted?.status).toBe(BatchStatus.COMPLETED);
      expect(persisted?.engineVersion).toBe('0.1.0');
      expect(persisted?.rulesVersion).toBe('2024.1');
    });

    it('auto-generates batchNumber when omitted by caller', async () => {
      const input: RunPersistentBatchInput = {
        engineVersion: '0.1.0',
        rulesVersion: '2024.1',
        filePaths: [sampleFilePath]
      };

      const result = await orchestrator.runBatch(tenantCtx, input);

      expect(result.success).toBe(true);
      expect(result.batch.batchNumber).toMatch(/^BATCH-\d+-[A-Z0-9]+$/);
      expect(result.batch.status).toBe(BatchStatus.COMPLETED);
    });
  });

  describe('5. Failure Propagation & Prevention of Premature Completion', () => {
    it('marks batch as FAILED when domain pipeline throws, never COMPLETED', async () => {
      const faultyPipeline = new PipelineOrchestrator();
      // Force processBatch to reject
      faultyPipeline.processBatch = async () => {
        throw new Error('Simulated domain parser failure: corrupted CSV header');
      };

      const faultyOrchestrator = new PersistentPipelineOrchestrator({
        importBatchRepo: batchRepo,
        pipelineOrchestrator: faultyPipeline
      });

      const input: RunPersistentBatchInput = {
        batchNumber: 'BATCH-TEST-FAIL-001',
        engineVersion: '0.1.0',
        rulesVersion: '2024.1',
        filePaths: [sampleFilePath]
      };

      await expect(faultyOrchestrator.runBatch(tenantCtx, input)).rejects.toThrow(
        DomainPipelineExecutionError
      );

      // Verify that the batch is marked FAILED in the repository
      const batch = await batchRepo.getBatchByNumber(tenantCtx, 'BATCH-TEST-FAIL-001');
      expect(batch).not.toBeNull();
      expect(batch?.status).toBe(BatchStatus.FAILED);
      expect(batch?.completedAt).toBeInstanceOf(Date);
    });

    it('preserves the original error as the cause in DomainPipelineExecutionError', async () => {
      const rootError = new Error('Original statutory calculation syntax error');
      const faultyPipeline = new PipelineOrchestrator();
      faultyPipeline.processBatch = async () => {
        throw rootError;
      };

      const faultyOrchestrator = new PersistentPipelineOrchestrator({
        importBatchRepo: batchRepo,
        pipelineOrchestrator: faultyPipeline
      });

      const input: RunPersistentBatchInput = {
        batchNumber: 'BATCH-TEST-CAUSE-001',
        engineVersion: '0.1.0',
        rulesVersion: '2024.1',
        filePaths: [sampleFilePath]
      };

      try {
        await faultyOrchestrator.runBatch(tenantCtx, input);
        expect.unreachable('Should have thrown DomainPipelineExecutionError');
      } catch (err: any) {
        expect(err).toBeInstanceOf(DomainPipelineExecutionError);
        expect(err.cause).toBe(rootError);
        expect(err.code).toBe('DOMAIN_PIPELINE_ERROR');
        expect(err.batchId).toBeDefined();
        expect(err.organizationId).toBe(validOrgId);
      }
    });

    it('marks batch as FAILED if transition to PROCESSING fails', async () => {
      // Mock updateBatchStatus to fail on PENDING -> PROCESSING transition
      const originalUpdate = batchRepo.updateBatchStatus.bind(batchRepo);
      batchRepo.updateBatchStatus = async (ctx, batchId, fromStatus, toStatus, metadata) => {
        if (fromStatus === BatchStatus.PENDING && toStatus === BatchStatus.PROCESSING) {
          throw new Error('Database connection dropped during lock acquisition');
        }
        return originalUpdate(ctx, batchId, fromStatus, toStatus, metadata);
      };

      const input: RunPersistentBatchInput = {
        batchNumber: 'BATCH-TEST-LOCK-FAIL-001',
        engineVersion: '0.1.0',
        rulesVersion: '2024.1',
        filePaths: [sampleFilePath]
      };

      await expect(orchestrator.runBatch(tenantCtx, input)).rejects.toThrow();

      // The catch block transitions the batch from PENDING directly to FAILED
      const batch = await batchRepo.getBatchByNumber(tenantCtx, 'BATCH-TEST-LOCK-FAIL-001');
      expect(batch).not.toBeNull();
      expect(batch?.status).toBe(BatchStatus.FAILED);
    });
  });

  describe('6. Backward Compatibility & Domain Independence', () => {
    it('existing PipelineOrchestrator runs completely independently without database', async () => {
      const purePipeline = new PipelineOrchestrator();
      const report = await purePipeline.processBatch([sampleFilePath]);

      expect(report).toBeDefined();
      expect(report.totalRecordsIngested).toBeGreaterThanOrEqual(1);
      expect(report.zeroDataLossVerified).toBe(true);
    });
  });
});
