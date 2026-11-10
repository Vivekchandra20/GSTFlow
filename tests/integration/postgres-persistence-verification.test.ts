import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

describe('Phase 3B.2: PostgreSQL Persistence Foundation & Security Verification', () => {
  let pgServer: any;
  let adminClient: pg.Client;
  let appClient: pg.Client;
  const testDbName = 'gstflow_test_db';
  const testPort = 54333;
  const dataDir = path.resolve('.pgdata_phase3b2');

  const orgAId = crypto.randomUUID();
  const orgBId = crypto.randomUUID();

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

    // 2. Connect as admin to default postgres database to create isolated test DB
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

    // 3. Connect to isolated test database as admin
    adminClient = new pg.Client({
      host: 'localhost',
      port: testPort,
      user: 'postgres',
      password: 'postgrespassword',
      database: testDbName
    });
    await adminClient.connect();

    // 4. Apply the initial migration script
    const migrationPath = path.resolve(
      'prisma/migrations/20261107000000_init_persistence_foundation/migration.sql'
    );
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');
    await adminClient.query(migrationSql);

    // 5. Connect as restricted application role gstflow_app
    appClient = new pg.Client({
      host: 'localhost',
      port: testPort,
      user: 'gstflow_app',
      password: 'gstflow_app_password',
      database: testDbName
    });
    await appClient.connect();
  }, 60000);

  afterAll(async () => {
    if (appClient) await appClient.end();
    if (adminClient) await adminClient.end();
    if (pgServer) {
      try {
        await pgServer.stop();
      } catch {}
    }
    // Clean up temporary data dir
    try {
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {}
  });

  // ==========================================
  // STEP 2: MIGRATION & SCHEMA INTEGRITY
  // ==========================================
  describe('Step 2: Migration Execution & Schema Integrity', () => {
    it('verifies all 16 tables exist in public schema', async () => {
      const res = await adminClient.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name;
      `);
      const tableNames = res.rows.map((r) => r.table_name);
      const expectedTables = [
        'batch_source_files',
        'canonical_credit_notes',
        'canonical_invoices',
        'canonical_stock_transfers',
        'credit_note_processing_results',
        'gst_registrations',
        'import_batches',
        'invoice_lines',
        'invoice_processing_results',
        'organizations',
        'processing_metrics',
        'reconciliations',
        'source_files',
        'source_records',
        'stock_transfer_processing_results',
        'validation_issues'
      ];
      expect(tableNames).toEqual(expectedTables);
    });

    it('verifies all 9 custom ENUM types are created', async () => {
      const res = await adminClient.query(`
        SELECT t.typname
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public' AND t.typtype = 'e'
        ORDER BY t.typname;
      `);
      const enumNames = res.rows.map((r) => r.typname);
      expect(enumNames).toContain('RecipientType');
      expect(enumNames).toContain('SupplyType');
      expect(enumNames).toContain('RecordType');
      expect(enumNames).toContain('PrimaryOutcome');
      expect(enumNames).toContain('StockTransferClassification');
      expect(enumNames).toContain('ReconciliationStatus');
      expect(enumNames).toContain('IssueSeverity');
      expect(enumNames).toContain('BatchStatus');
      expect(enumNames).toContain('FileBatchStatus');
    });

    it('confirms exact numeric column precision across domain fields', async () => {
      const res = await adminClient.query(`
        SELECT table_name, column_name, numeric_precision, numeric_scale
        FROM information_schema.columns
        WHERE table_schema = 'public' AND data_type = 'numeric'
        ORDER BY table_name, column_name;
      `);
      const precisionMap = new Map(
        res.rows.map((r) => [`${r.table_name}.${r.column_name}`, `${r.numeric_precision},${r.numeric_scale}`])
      );

      // Invoice Totals: NUMERIC(14, 2)
      expect(precisionMap.get('invoice_processing_results.total_taxable_value')).toBe('14,2');
      // Unit Price: NUMERIC(14, 4)
      expect(precisionMap.get('invoice_lines.unit_price')).toBe('14,4');
      // Quantity: NUMERIC(12, 3)
      expect(precisionMap.get('invoice_lines.quantity')).toBe('12,3');
      // Tax Rate: NUMERIC(6, 4)
      expect(precisionMap.get('invoice_lines.tax_rate')).toBe('6,4');
      // Macro Aggregate: NUMERIC(16, 2)
      expect(precisionMap.get('processing_metrics.aggregate_taxable_turnover')).toBe('16,2');
    });
  });

  // ==========================================
  // STEP 3: RLS POLICY & ROLE VERIFICATION
  // ==========================================
  describe('Step 3: Row Level Security (RLS) & Role Verification', () => {
    it('verifies RLS is enabled and forced on all 16 tenant tables via pg_class', async () => {
      const res = await adminClient.query(`
        SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
        ORDER BY c.relname;
      `);
      expect(res.rows.length).toBe(16);
      for (const row of res.rows) {
        expect(row.relrowsecurity).toBe(true);
        expect(row.relforcerowsecurity).toBe(true);
      }
    });

    it('verifies application role gstflow_app has rolbypassrls = false, is not superuser and not owner', async () => {
      const roleRes = await adminClient.query(`
        SELECT rolname, rolsuper, rolcanlogin, rolbypassrls
        FROM pg_roles
        WHERE rolname = 'gstflow_app';
      `);
      expect(roleRes.rows[0].rolsuper).toBe(false);
      expect(roleRes.rows[0].rolcanlogin).toBe(true);
      expect(roleRes.rows[0].rolbypassrls).toBe(false);

      const ownerRes = await adminClient.query(`
        SELECT tableowner
        FROM pg_tables
        WHERE schemaname = 'public'
        GROUP BY tableowner;
      `);
      // Tables are owned by postgres, not gstflow_app
      expect(ownerRes.rows.map((r) => r.tableowner)).not.toContain('gstflow_app');
    });

    it('verifies missing tenant context fails closed (0 rows exposed outside transaction)', async () => {
      // First seed Org A and Org B records via admin
      await adminClient.query(`
        INSERT INTO organizations (id, name, pan, data_retention_months, updated_at)
        VALUES 
          ('${orgAId}', 'Client Alpha Private Limited', 'AAACA1234A', 72, NOW()),
          ('${orgBId}', 'Client Beta Retailers LLP', 'BBBCB5678B', 72, NOW())
        ON CONFLICT (id) DO NOTHING;
      `);

      // Query organizations table as application role with NO context set
      const res = await appClient.query('SELECT * FROM organizations;');
      expect(res.rows.length).toBe(0);
    });

    it('verifies empty string tenant context fails closed inside a transaction', async () => {
      await appClient.query('BEGIN;');
      await appClient.query(`SET LOCAL app.current_organization_id = '';`);
      const res = await appClient.query('SELECT * FROM organizations;');
      await appClient.query('COMMIT;');
      expect(res.rows.length).toBe(0);
    });

    it('verifies transaction without SET LOCAL fails closed', async () => {
      await appClient.query('BEGIN;');
      const res = await appClient.query('SELECT * FROM organizations;');
      await appClient.query('COMMIT;');
      expect(res.rows.length).toBe(0);
    });
  });

  // ==========================================
  // STEP 4: CONSTRAINT TESTS
  // ==========================================
  describe('Step 4: Constraint Enforcement Tests', () => {
    it('rejects duplicate canonical invoice within the same organization (Constraint 1)', async () => {
      await adminClient.query(`
        INSERT INTO canonical_invoices (
          id, organization_id, seller_gstin, financial_year, invoice_number,
          invoice_date, order_id, recipient_type, ship_from_state_code,
          place_of_supply_state_code, supply_type
        ) VALUES (
          gen_random_uuid(), '${orgAId}', '29AAACA1234A1Z5', '2026-2027', 'INV-2026-001',
          '2026-05-10', 'ORD-1001', 'B2C', '29', '29', 'INTRASTATE'
        );
      `);

      // Attempt duplicate invoice number for Org A in FY 2026-2027
      await expect(
        adminClient.query(`
          INSERT INTO canonical_invoices (
            id, organization_id, seller_gstin, financial_year, invoice_number,
            invoice_date, order_id, recipient_type, ship_from_state_code,
            place_of_supply_state_code, supply_type
          ) VALUES (
            gen_random_uuid(), '${orgAId}', '29AAACA1234A1Z5', '2026-2027', 'INV-2026-001',
            '2026-05-11', 'ORD-1002', 'B2C', '29', '29', 'INTRASTATE'
          );
        `)
      ).rejects.toThrow(/duplicate key value violates unique constraint/);
    });

    it('allows identical invoice number in a different organization (Constraint 2)', async () => {
      // Org B inserting identical invoice number INV-2026-001 in FY 2026-2027
      const res = await adminClient.query(`
        INSERT INTO canonical_invoices (
          id, organization_id, seller_gstin, financial_year, invoice_number,
          invoice_date, order_id, recipient_type, ship_from_state_code,
          place_of_supply_state_code, supply_type
        ) VALUES (
          gen_random_uuid(), '${orgBId}', '27BBBCB5678B1Z2', '2026-2027', 'INV-2026-001',
          '2026-05-10', 'ORD-2001', 'B2B', '27', '27', 'INTRASTATE'
        ) RETURNING id;
      `);
      expect(res.rows.length).toBe(1);
    });

    it('rejects duplicate credit note reconciliation on credit_note_result_id (Constraint 3)', async () => {
      // 1. Seed batch and source records
      const fileId = crypto.randomUUID();
      const batchId = crypto.randomUUID();
      const rec1Id = crypto.randomUUID();
      const rec2Id = crypto.randomUUID();
      const canInvId = crypto.randomUUID();
      const canCnId = crypto.randomUUID();
      const invResId = crypto.randomUUID();
      const cnResId = crypto.randomUUID();

      await adminClient.query(`
        INSERT INTO source_files (id, organization_id, file_name, file_fingerprint, file_size_bytes, storage_uri, source_report_type)
        VALUES ('${fileId}', '${orgAId}', 'report.csv', 'hash123', 1024, 's3://bucket/report.csv', 'MTR_COMBINED');

        INSERT INTO import_batches (id, organization_id, batch_number, engine_version, rules_version)
        VALUES ('${batchId}', '${orgAId}', 'BATCH-001', 'v0.2.0', '2024.1');

        INSERT INTO source_records (id, organization_id, source_file_id, physical_line_number, logical_record_number, record_type, raw_payload)
        VALUES 
          ('${rec1Id}', '${orgAId}', '${fileId}', 1, 1, 'OUTWARD_SUPPLY', '{}'),
          ('${rec2Id}', '${orgAId}', '${fileId}', 2, 2, 'CREDIT_NOTE', '{}');

        INSERT INTO canonical_invoices (id, organization_id, seller_gstin, financial_year, invoice_number, invoice_date, order_id, recipient_type, ship_from_state_code, place_of_supply_state_code, supply_type)
        VALUES ('${canInvId}', '${orgAId}', '29AAACA1234A1Z5', '2026-2027', 'INV-2026-999', '2026-06-01', 'ORD-999', 'B2C', '29', '29', 'INTRASTATE');

        INSERT INTO canonical_credit_notes (id, organization_id, seller_gstin, financial_year, credit_note_number, credit_note_date, recipient_type)
        VALUES ('${canCnId}', '${orgAId}', '29AAACA1234A1Z5', '2026-2027', 'CN-2026-001', '2026-06-15', 'B2C');

        INSERT INTO invoice_processing_results (
          id, organization_id, import_batch_id, canonical_invoice_id, source_record_id,
          total_taxable_value, total_invoice_amount, primary_outcome
        ) VALUES (
          '${invResId}', '${orgAId}', '${batchId}', '${canInvId}', '${rec1Id}',
          1000.00, 1180.00, 'VALID'
        );

        INSERT INTO credit_note_processing_results (
          id, organization_id, import_batch_id, canonical_credit_note_id, source_record_id,
          taxable_value_reversal, credit_note_total, raw_signed_amount_text, signed_amount,
          reconciliation_status, primary_outcome
        ) VALUES (
          '${cnResId}', '${orgAId}', '${batchId}', '${canCnId}', '${rec2Id}',
          500.00, 590.00, '-590.00', -590.00, 'MATCHED_PARTIAL', 'VALID'
        );

        INSERT INTO reconciliations (
          id, organization_id, import_batch_id, credit_note_result_id, invoice_result_id,
          reconciliation_status, taxable_reversed, total_reversed, prior_cumulative_taxable, post_cumulative_taxable
        ) VALUES (
          gen_random_uuid(), '${orgAId}', '${batchId}', '${cnResId}', '${invResId}',
          'MATCHED_PARTIAL', 500.00, 590.00, 0.00, 500.00
        );
      `);

      // Attempt second reconciliation for the SAME credit_note_result_id
      await expect(
        adminClient.query(`
          INSERT INTO reconciliations (
            id, organization_id, import_batch_id, credit_note_result_id, invoice_result_id,
            reconciliation_status, taxable_reversed, total_reversed, prior_cumulative_taxable, post_cumulative_taxable
          ) VALUES (
            gen_random_uuid(), '${orgAId}', '${batchId}', '${cnResId}', '${invResId}',
            'MATCHED_PARTIAL', 500.00, 590.00, 500.00, 1000.00
          );
        `)
      ).rejects.toThrow(/duplicate key value violates unique constraint/);
    });

    it('rejects cross-tenant invoice-line insertion via composite foreign key (Constraint 4)', async () => {
      // Find Org A invoice_processing_result
      const res = await adminClient.query(
        `SELECT id, organization_id FROM invoice_processing_results WHERE organization_id = '${orgAId}' LIMIT 1;`
      );
      const orgAInvResId = res.rows[0].id;

      // Seed an Org B source_record
      const orgBFileId = crypto.randomUUID();
      const orgBRecId = crypto.randomUUID();
      await adminClient.query(`
        INSERT INTO source_files (id, organization_id, file_name, file_fingerprint, file_size_bytes, storage_uri, source_report_type)
        VALUES ('${orgBFileId}', '${orgBId}', 'beta_file.csv', 'hashbeta', 2048, 's3://beta/file.csv', 'MTR_B2B');

        INSERT INTO source_records (id, organization_id, source_file_id, physical_line_number, logical_record_number, record_type, raw_payload)
        VALUES ('${orgBRecId}', '${orgBId}', '${orgBFileId}', 1, 1, 'OUTWARD_SUPPLY', '{}');
      `);

      // Org B attempts to insert an InvoiceLine pointing to Org A's invoice processing result
      await expect(
        adminClient.query(`
          INSERT INTO invoice_lines (
            id, organization_id, invoice_result_id, source_record_id, line_number,
            quantity, item_taxable_value, tax_rate, total_line_amount
          ) VALUES (
            gen_random_uuid(), '${orgBId}', '${orgAInvResId}', '${orgBRecId}', 1,
            1.000, 500.00, 18.0000, 590.00
          );
        `)
      ).rejects.toThrow(/violates foreign key constraint/);
    });

    it('rejects cross-tenant reconciliation insertion (Constraint 5)', async () => {
      // Create a fresh un-reconciled credit note for Org A
      const freshCanCnId = crypto.randomUUID();
      const freshCnResId = crypto.randomUUID();
      const orgARec = await adminClient.query(
        `SELECT id, source_file_id FROM source_records WHERE organization_id = '${orgAId}' LIMIT 1;`
      );
      const orgARecId = orgARec.rows[0].id;
      const orgABatch = await adminClient.query(
        `SELECT id FROM import_batches WHERE organization_id = '${orgAId}' LIMIT 1;`
      );
      const orgABatchId = orgABatch.rows[0].id;

      await adminClient.query(`
        INSERT INTO canonical_credit_notes (id, organization_id, seller_gstin, financial_year, credit_note_number, credit_note_date, recipient_type)
        VALUES ('${freshCanCnId}', '${orgAId}', '29AAACA1234A1Z5', '2026-2027', 'CN-2026-CROSS', '2026-06-20', 'B2C');

        INSERT INTO credit_note_processing_results (
          id, organization_id, import_batch_id, canonical_credit_note_id, source_record_id,
          taxable_value_reversal, credit_note_total, raw_signed_amount_text, signed_amount,
          reconciliation_status, primary_outcome
        ) VALUES (
          '${freshCnResId}', '${orgAId}', '${orgABatchId}', '${freshCanCnId}', '${orgARecId}',
          300.00, 354.00, '-354.00', -354.00, 'UNMATCHED_ORPHAN', 'VALID'
        );
      `);

      // Create an Org B invoice result
      const orgBInvId = crypto.randomUUID();
      const orgBBatchId = crypto.randomUUID();
      const orgBRec = await adminClient.query(
        `SELECT id FROM source_records WHERE organization_id = '${orgBId}' LIMIT 1;`
      );
      const orgBRecId = orgBRec.rows[0].id;
      const orgBCanInv = await adminClient.query(
        `SELECT id FROM canonical_invoices WHERE organization_id = '${orgBId}' LIMIT 1;`
      );
      const orgBCanInvId = orgBCanInv.rows[0].id;

      await adminClient.query(`
        INSERT INTO import_batches (id, organization_id, batch_number, engine_version, rules_version)
        VALUES ('${orgBBatchId}', '${orgBId}', 'BATCH-B001', 'v0.2.0', '2024.1');

        INSERT INTO invoice_processing_results (
          id, organization_id, import_batch_id, canonical_invoice_id, source_record_id,
          total_taxable_value, total_invoice_amount, primary_outcome
        ) VALUES (
          '${orgBInvId}', '${orgBId}', '${orgBBatchId}', '${orgBCanInvId}', '${orgBRecId}',
          2000.00, 2360.00, 'VALID'
        );
      `);

      // Org A attempts to reconcile against Org B's invoice
      await expect(
        adminClient.query(`
          INSERT INTO reconciliations (
            id, organization_id, import_batch_id, credit_note_result_id, invoice_result_id,
            reconciliation_status, taxable_reversed, total_reversed, prior_cumulative_taxable, post_cumulative_taxable
          ) VALUES (
            gen_random_uuid(), '${orgAId}', '${orgABatchId}', '${freshCnResId}', '${orgBInvId}',
            'MATCHED_PARTIAL', 300.00, 354.00, 0.00, 300.00
          );
        `)
      ).rejects.toThrow(/violates foreign key constraint/);
    });

    it('rejects invalid organization references (Constraint 6)', async () => {
      const nonExistentOrgId = crypto.randomUUID();
      await expect(
        adminClient.query(`
          INSERT INTO canonical_invoices (
            id, organization_id, seller_gstin, financial_year, invoice_number,
            invoice_date, order_id, recipient_type, ship_from_state_code,
            place_of_supply_state_code, supply_type
          ) VALUES (
            gen_random_uuid(), '${nonExistentOrgId}', '29AAACA1234A1Z5', '2026-2027', 'INV-INVALID-ORG',
            '2026-05-10', 'ORD-9999', 'B2C', '29', '29', 'INTRASTATE'
          );
        `)
      ).rejects.toThrow(/violates foreign key constraint/);
    });

    it('verifies exact financial precision without float drift (Constraint 7)', async () => {
      const invRes = await adminClient.query(
        `SELECT id, organization_id, import_batch_id, source_record_id FROM invoice_processing_results WHERE organization_id = '${orgAId}' LIMIT 1;`
      );
      const invResId = invRes.rows[0].id;
      const recId = invRes.rows[0].source_record_id;

      // Insert line with fractional quantity 1.250, unit price 123.4567, tax rate 18.0000%
      await adminClient.query(`
        INSERT INTO invoice_lines (
          id, organization_id, invoice_result_id, source_record_id, line_number,
          quantity, unit_price, item_taxable_value, tax_rate, cgst_rate, cgst_amount,
          sgst_rate, sgst_amount, igst_rate, igst_amount, total_line_amount
        ) VALUES (
          gen_random_uuid(), '${orgAId}', '${invResId}', '${recId}', 99,
          1.250, 123.4567, 154.32, 18.0000, 9.0000, 13.89,
          9.0000, 13.89, 0.0000, 0.00, 182.10
        );
      `);

      const queryRes = await adminClient.query(
        `SELECT quantity, unit_price, item_taxable_value, tax_rate, total_line_amount FROM invoice_lines WHERE line_number = 99;`
      );
      const row = queryRes.rows[0];
      expect(row.quantity).toBe('1.250');
      expect(row.unit_price).toBe('123.4567');
      expect(row.item_taxable_value).toBe('154.32');
      expect(row.tax_rate).toBe('18.0000');
      expect(row.total_line_amount).toBe('182.10');
    });
  });

  // ==========================================
  // STEP 5: SECURITY & TRANSACTION-LOCAL RLS
  // ==========================================
  describe('Step 5: Security & Transaction-Local Isolation Tests', () => {
    it('enforces that Tenant A cannot read Tenant B invoices using transaction-local SET LOCAL', async () => {
      await appClient.query('BEGIN;');
      await appClient.query(`SET LOCAL app.current_organization_id = '${orgAId}';`);

      const res = await appClient.query('SELECT * FROM canonical_invoices;');
      await appClient.query('COMMIT;');

      expect(res.rows.length).toBeGreaterThan(0);
      for (const row of res.rows) {
        expect(row.organization_id).toBe(orgAId);
        expect(row.organization_id).not.toBe(orgBId);
      }
    });

    it('verifies connection pool safety: context resets after transaction COMMIT with zero leak', async () => {
      // 1. Transaction executes with Org A context
      await appClient.query('BEGIN;');
      await appClient.query(`SET LOCAL app.current_organization_id = '${orgAId}';`);
      const inTxRes = await appClient.query('SELECT * FROM canonical_invoices;');
      expect(inTxRes.rows.length).toBeGreaterThan(0);
      await appClient.query('COMMIT;');

      // 2. Immediate query on the same connection outside transaction: GUC must be empty and return 0 rows
      const gucCheck = await appClient.query("SELECT current_setting('app.current_organization_id', true) AS guc;");
      expect(gucCheck.rows[0].guc).toBeFalsy();

      const leakedRes = await appClient.query('SELECT * FROM canonical_invoices;');
      expect(leakedRes.rows.length).toBe(0);
    });

    it('verifies connection pool safety: context resets after transaction ROLLBACK with zero leak', async () => {
      // 1. Transaction starts with Org A context but aborts
      await appClient.query('BEGIN;');
      await appClient.query(`SET LOCAL app.current_organization_id = '${orgAId}';`);
      await appClient.query('ROLLBACK;');

      // 2. Immediate query on the same connection outside transaction: GUC must be empty and return 0 rows
      const gucCheck = await appClient.query("SELECT current_setting('app.current_organization_id', true) AS guc;");
      expect(gucCheck.rows[0].guc).toBeFalsy();

      const afterRollbackRes = await appClient.query('SELECT * FROM canonical_invoices;');
      expect(afterRollbackRes.rows.length).toBe(0);
    });

    it('enforces that Tenant A cannot modify Tenant B invoices in a transaction', async () => {
      await appClient.query('BEGIN;');
      await appClient.query(`SET LOCAL app.current_organization_id = '${orgAId}';`);

      // Attempt to modify Org B's invoice
      const updateRes = await appClient.query(`
        UPDATE canonical_invoices
        SET invoice_number = 'TAMPERED'
        WHERE organization_id = '${orgBId}';
      `);
      expect(updateRes.rowCount).toBe(0);
      await appClient.query('COMMIT;');

      // Verify Org B invoice was NOT modified
      const checkRes = await adminClient.query(`
        SELECT invoice_number FROM canonical_invoices WHERE organization_id = '${orgBId}';
      `);
      expect(checkRes.rows[0].invoice_number).not.toBe('TAMPERED');
    });

    it('enforces that Tenant A cannot read Tenant B source records in a transaction', async () => {
      await appClient.query('BEGIN;');
      await appClient.query(`SET LOCAL app.current_organization_id = '${orgAId}';`);

      const res = await appClient.query('SELECT * FROM source_records;');
      await appClient.query('COMMIT;');

      expect(res.rows.length).toBeGreaterThan(0);
      for (const row of res.rows) {
        expect(row.organization_id).toBe(orgAId);
        expect(row.organization_id).not.toBe(orgBId);
      }
    });

    it('enforces that spoofed organization ID in query predicate is blocked by RLS in a transaction', async () => {
      await appClient.query('BEGIN;');
      await appClient.query(`SET LOCAL app.current_organization_id = '${orgAId}';`);

      // Query explicitly asking for Org B
      const res = await appClient.query(`
        SELECT * FROM canonical_invoices WHERE organization_id = '${orgBId}';
      `);
      await appClient.query('COMMIT;');

      expect(res.rows.length).toBe(0);
    });
  });
});
