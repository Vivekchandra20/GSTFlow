import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import {
  PersistentPipelineOrchestrator,
  RunPersistentBatchInput,
  DomainPipelineExecutionError
} from '../../src/application/persistent-pipeline/index.js';
import {
  PrismaImportBatchRepository,
  PrismaTransactionManager,
  TenantContext,
  BatchStatus,
  runInTenantTransaction
} from '../../src/repositories/index.js';
import { PipelineOrchestrator } from '../../src/pipeline/pipeline-orchestrator.js';

describe('Phase 3B.4.1: Persistent Pipeline Orchestrator Integration Suite', () => {
  let pgServer: any;
  let adminClient: pg.Client;
  let prisma: PrismaClient;

  let batchRepo: PrismaImportBatchRepository;
  let txManager: PrismaTransactionManager;
  let orchestrator: PersistentPipelineOrchestrator;

  const testDbName = 'gstflow_phase3b41_test_db';
  const testPort = 54337;
  const dataDir = path.resolve('.pgdata_phase3b41');

  const orgA: TenantContext = { organizationId: crypto.randomUUID() };
  const orgB: TenantContext = { organizationId: crypto.randomUUID() };

  const syntheticB2BPath = path.resolve(
    __dirname,
    '../../GSTFlow_Synthetic_Test_Suite/amazon/synthetic_amazon_mtr_b2b.csv'
  );

  beforeAll(async () => {
    if (fs.existsSync(dataDir)) {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {}
    }

    // 1. Initialize and start isolated PostgreSQL 16 server
    const epModule = await import('embedded-postgres');
    const EmbeddedPostgresClass = epModule.default || epModule;
    pgServer = new (EmbeddedPostgresClass as any)({
      databaseDir: dataDir,
      port: testPort,
      user: 'postgres',
      password: 'postgrespassword',
      persistent: false
    });

    await pgServer.initialise();
    await pgServer.start();

    // 2. Connect as root admin to create test database
    const rootClient = new pg.Client({
      host: 'localhost',
      port: testPort,
      user: 'postgres',
      password: 'postgrespassword',
      database: 'postgres'
    });
    await rootClient.connect();
    await rootClient.query(`DROP DATABASE IF EXISTS ${testDbName};`);
    await rootClient.query(`CREATE DATABASE ${testDbName};`);
    await rootClient.end();

    // 3. Connect to test DB as admin and apply initial migration
    adminClient = new pg.Client({
      host: 'localhost',
      port: testPort,
      user: 'postgres',
      password: 'postgrespassword',
      database: testDbName
    });
    await adminClient.connect();

    const migrationPath = path.resolve(
      'prisma/migrations/20261107000000_init_persistence_foundation/migration.sql'
    );
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');
    await adminClient.query(migrationSql);

    // 4. Seed test organizations as admin
    await adminClient.query(`
      INSERT INTO organizations (id, name, pan, data_retention_months, created_at, updated_at)
      VALUES 
        ('${orgA.organizationId}', 'Persistent Pipeline Org A', 'AAACA1234A', 72, NOW(), NOW()),
        ('${orgB.organizationId}', 'Persistent Pipeline Org B', 'AAACB5678B', 72, NOW(), NOW());
    `);

    // 5. Connect Prisma as restricted application user gstflow_app
    const databaseUrl = `postgresql://gstflow_app:gstflow_app_password@localhost:${testPort}/${testDbName}`;
    prisma = new PrismaClient({
      datasources: {
        db: { url: databaseUrl }
      }
    });
    await prisma.$connect();

    batchRepo = new PrismaImportBatchRepository(prisma);
    txManager = new PrismaTransactionManager(prisma);
    orchestrator = new PersistentPipelineOrchestrator({
      importBatchRepo: batchRepo,
      transactionManager: txManager
    });
  }, 60000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (adminClient) await adminClient.end();
    if (pgServer) {
      await pgServer.stop();
    }
  }, 30000);

  it('1. Successfully executes a batch and persists lifecycle state in PostgreSQL', async () => {
    const input: RunPersistentBatchInput = {
      batchNumber: 'BATCH-PG-SUCCESS-001',
      engineVersion: '0.1.0',
      rulesVersion: '2024.1',
      filePaths: [syntheticB2BPath]
    };

    const result = await orchestrator.runBatch(orgA, input);

    expect(result.success).toBe(true);
    expect(result.batch.batchNumber).toBe('BATCH-PG-SUCCESS-001');
    expect(result.batch.status).toBe(BatchStatus.COMPLETED);
    expect(result.batch.completedAt).toBeInstanceOf(Date);
    expect(result.report.totalRecordsIngested).toBe(5000);

    // Verify record in PostgreSQL directly with RLS active
    const savedBatch = await runInTenantTransaction(prisma, orgA, async (tx) => {
      return await tx.importBatch.findUnique({
        where: { id: result.batch.id }
      });
    });

    expect(savedBatch).not.toBeNull();
    expect(savedBatch?.status).toBe('COMPLETED');
    expect(savedBatch?.totalRecordsProcessed).toBe(5000);
    expect(savedBatch?.organizationId).toBe(orgA.organizationId);
  });

  it('2. Enforces PostgreSQL RLS tenant isolation across import batches', async () => {
    // Attempt to access Org A's batch from Org B
    const orgBBatchLookup = await batchRepo.getBatchByNumber(orgB, 'BATCH-PG-SUCCESS-001');
    expect(orgBBatchLookup).toBeNull();

    // Verify via direct RLS query in Org B context
    const rlsQuery = await runInTenantTransaction(prisma, orgB, async (tx) => {
      return await tx.importBatch.findMany({
        where: { batchNumber: 'BATCH-PG-SUCCESS-001' }
      });
    });
    expect(rlsQuery.length).toBe(0);
  });

  it('3. Fails the batch in PostgreSQL when domain pipeline throws and never completes', async () => {
    const faultyPipeline = new PipelineOrchestrator();
    faultyPipeline.processBatch = async () => {
      throw new Error('Simulated domain engine parse error');
    };

    const faultyOrchestrator = new PersistentPipelineOrchestrator({
      importBatchRepo: batchRepo,
      pipelineOrchestrator: faultyPipeline
    });

    const input: RunPersistentBatchInput = {
      batchNumber: 'BATCH-PG-FAIL-001',
      engineVersion: '0.1.0',
      rulesVersion: '2024.1',
      filePaths: [syntheticB2BPath]
    };

    await expect(faultyOrchestrator.runBatch(orgA, input)).rejects.toThrow(
      DomainPipelineExecutionError
    );

    // Verify the batch status in PostgreSQL is FAILED, not PROCESSING or COMPLETED
    const failedBatch = await runInTenantTransaction(prisma, orgA, async (tx) => {
      return await tx.importBatch.findFirst({
        where: { batchNumber: 'BATCH-PG-FAIL-001' }
      });
    });

    expect(failedBatch).not.toBeNull();
    expect(failedBatch?.status).toBe('FAILED');
    expect(failedBatch?.completedAt).toBeInstanceOf(Date);
  });

  it('4. Transaction-local tenant context does not leak across transactions', async () => {
    // 1. Run in Org A
    await runInTenantTransaction(prisma, orgA, async (tx) => {
      const res = await tx.$queryRaw<any[]>`SELECT current_setting('app.current_organization_id', true) as org_id`;
      expect(res[0].org_id).toBe(orgA.organizationId);
    });

    // 2. Query outside transaction without SET LOCAL -> should evaluate to null
    const outsideRes = await prisma.$queryRaw<any[]>`
      SELECT NULLIF(current_setting('app.current_organization_id', true), '') as org_id
    `;
    expect(outsideRes[0].org_id).toBeNull();
  });
});
