import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parse } from 'csv-parse';
import {
  TenantContext,
  ISourceRecordRepository,
  IImportBatchRepository,
  FileBatchStatus,
  RecordType,
  CreateSourceRecordInput,
  DuplicateSourceFileError,
  DuplicateBatchAssociationError
} from '../../repositories/types.js';
import {
  SourceFileStagingResult,
  SourceFileStagingTiming
} from './persistent-pipeline.types.js';
import {
  SourceFileNotFoundOrInaccessibleError,
  FileCorruptedOrMalformedError,
  StagingExecutionError,
  ConcurrentStagingError
} from './persistent-pipeline.errors.js';
import { logger } from '../../utils/logger.js';

export interface SourceStagingServiceOptions {
  sourceRecordRepo: ISourceRecordRepository;
  batchRepo: IImportBatchRepository;
  defaultChunkSize?: number;
  allowedUploadDir?: string;
  storageBaseDir?: string;
}

export interface SecureFileHandle {
  fileHandle: fs.promises.FileHandle;
  canonicalPath: string;
  initialStat: fs.Stats;
}

/**
 * Service responsible for memory-bounded streaming ingestion of raw marketplace source files
 * into PostgreSQL with SHA-256 fingerprint deduplication, physical line tracking, and chunked transactions.
 */
export class SourceStagingService {
  private readonly sourceRecordRepo: ISourceRecordRepository;
  private readonly batchRepo: IImportBatchRepository;
  private readonly defaultChunkSize: number;
  private readonly allowedUploadDir?: string;
  private readonly storageBaseDir: string;

  constructor(options: SourceStagingServiceOptions) {
    this.sourceRecordRepo = options.sourceRecordRepo;
    this.batchRepo = options.batchRepo;
    this.defaultChunkSize = Math.max(100, Math.min(10000, options.defaultChunkSize || 2500));
    this.allowedUploadDir = options.allowedUploadDir ? path.resolve(options.allowedUploadDir) : undefined;
    this.storageBaseDir = path.resolve(options.storageBaseDir || '.gstflow_storage');
  }

  /**
   * Validates that the file path exists, is a regular file, and respects directory traversal boundaries.
   * Uses path-relative containment to prevent prefix collisions and symlink escapes.
   */
  public validateFilePath(filePath: string, allowedUploadDir?: string): string {
    if (!filePath || typeof filePath !== 'string' || filePath.trim() === '') {
      throw new SourceFileNotFoundOrInaccessibleError('Source file path must be a non-empty string.', {
        filePath
      });
    }

    const trimmed = filePath.trim();
    if (!fs.existsSync(trimmed)) {
      throw new SourceFileNotFoundOrInaccessibleError(`Source file does not exist: '${filePath}'.`, {
        filePath: trimmed
      });
    }

    let canonicalPath: string;
    try {
      canonicalPath = fs.realpathSync(trimmed);
    } catch (realErr: any) {
      throw new SourceFileNotFoundOrInaccessibleError(`Failed to resolve canonical path for '${filePath}': ${realErr.message}`, {
        cause: realErr,
        filePath: trimmed
      });
    }

    const boundary = allowedUploadDir ? path.resolve(allowedUploadDir) : this.allowedUploadDir;

    if (boundary) {
      let canonicalBoundary: string;
      try {
        canonicalBoundary = fs.realpathSync(boundary);
      } catch {
        canonicalBoundary = path.resolve(boundary);
      }

      const relative = path.relative(canonicalBoundary, canonicalPath);
      const isContained =
        relative !== '' &&
        !relative.startsWith('..') &&
        !path.isAbsolute(relative);

      if (!isContained) {
        throw new SourceFileNotFoundOrInaccessibleError(
          `Path traversal blocked: File path '${filePath}' resolves outside permitted directory '${canonicalBoundary}'.`,
          { filePath: canonicalPath }
        );
      }
    }

    const stat = fs.statSync(canonicalPath);
    if (!stat.isFile()) {
      throw new SourceFileNotFoundOrInaccessibleError(
        `Candidate path is not a regular file: '${filePath}'. Directories and special files are prohibited.`,
        { filePath: canonicalPath }
      );
    }

    return canonicalPath;
  }

  /**
   * Securely opens candidate file handle, verifies directory containment, and confirms regular file type.
   * Protects against TOCTOU and symlink redirection between validation and reading.
   */
  public async openSecureFile(
    filePath: string,
    allowedUploadDir?: string
  ): Promise<SecureFileHandle> {
    const canonicalPath = this.validateFilePath(filePath, allowedUploadDir);

    let fileHandle: fs.promises.FileHandle;
    try {
      fileHandle = await fs.promises.open(canonicalPath, 'r');
    } catch (openErr: any) {
      throw new SourceFileNotFoundOrInaccessibleError(
        `Failed to open file descriptor for '${filePath}': ${openErr.message}`,
        { cause: openErr, filePath: canonicalPath }
      );
    }

    try {
      const initialStat = await fileHandle.stat();
      if (!initialStat.isFile()) {
        throw new SourceFileNotFoundOrInaccessibleError(
          `Candidate path is not a regular file: '${filePath}'.`,
          { filePath: canonicalPath }
        );
      }

      return {
        fileHandle,
        canonicalPath,
        initialStat
      };
    } catch (statErr) {
      await fileHandle.close();
      throw statErr;
    }
  }

  /**
   * Computes the SHA-256 fingerprint and file size in bytes using a memory-efficient stream.
   */
  public async computeFileFingerprint(
    filePath: string
  ): Promise<{ fingerprint: string; fileSizeBytes: bigint; hashingMs: number }> {
    const startTime = Date.now();
    const secure = await this.openSecureFile(filePath);

    try {
      return await new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = secure.fileHandle.createReadStream();

        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => {
          const fingerprint = hash.digest('hex');
          const hashingMs = Date.now() - startTime;
          resolve({
            fingerprint,
            fileSizeBytes: BigInt(secure.initialStat.size),
            hashingMs
          });
        });
        stream.on('error', (err) => {
          stream.destroy();
          reject(
            new FileCorruptedOrMalformedError(`Failed to stream and hash file '${filePath}': ${err.message}`, {
              cause: err,
              filePath: secure.canonicalPath
            })
          );
        });
      });
    } finally {
      await secure.fileHandle.close();
    }
  }

  /**
   * Inactive/preliminary report type inference from headers or file name.
   */
  public inferReportType(headers: string[], filePath?: string): string {
    const headerSet = new Set(headers.map((h) => h.trim()));

    if (headerSet.has('Transfer Invoice Number') || headerSet.has('Source GSTIN')) {
      return 'STOCK_TRANSFER';
    }
    if (headerSet.has('Credit Note Total') || headerSet.has('Original Invoice Number')) {
      return 'CREDIT_NOTE';
    }
    if (headerSet.has('Expected Issue') || headerSet.has('Test Case ID')) {
      return 'EDGE_CASES';
    }
    if (headerSet.has('Transaction Type')) {
      return 'AMAZON_MTR_LIVE';
    }
    if (filePath) {
      const lower = filePath.toLowerCase();
      if (lower.includes('b2b')) return 'B2B';
      if (lower.includes('b2c')) return 'B2C';
      if (lower.includes('stock_transfer') || lower.includes('stock transfer')) return 'STOCK_TRANSFER';
      if (lower.includes('credit_notes') || lower.includes('credit notes')) return 'CREDIT_NOTE';
      if (lower.includes('invalid') || lower.includes('edge')) return 'EDGE_CASES';
    }
    return 'UNKNOWN';
  }

  /**
   * Classifies an unnormalized raw record into its statutory RecordType enum.
   */
  public classifyRecordType(
    headers: string[],
    row: Record<string, string>,
    fileName?: string
  ): RecordType {
    // 1. Amazon MTR transaction type check
    const txnType = row['Transaction Type']?.trim().toLowerCase();
    if (txnType) {
      if (txnType.includes('refund')) return RecordType.CREDIT_NOTE;
      if (txnType.includes('cancel')) return RecordType.CANCELLED_ORDER;
      if (txnType.includes('transfer')) return RecordType.STOCK_TRANSFER;
      if (txnType.includes('shipment')) return RecordType.OUTWARD_SUPPLY;
    }

    // 2. Header-based classification
    if (row['Credit Note Total'] || row['Original Invoice Number']) {
      return RecordType.CREDIT_NOTE;
    }
    if (row['Transfer Invoice Number'] || row['Source GSTIN']) {
      return RecordType.STOCK_TRANSFER;
    }

    // 3. Filename-based fallback
    if (fileName) {
      const lower = fileName.toLowerCase();
      if (lower.includes('credit_note')) return RecordType.CREDIT_NOTE;
      if (lower.includes('stock_transfer') || lower.includes('stock transfer')) return RecordType.STOCK_TRANSFER;
      if (lower.includes('b2b') || lower.includes('b2c')) return RecordType.OUTWARD_SUPPLY;
    }

    return RecordType.OUTWARD_SUPPLY;
  }

  /**
   * Persists an immutable content-addressed copy of the file under .gstflow_storage.
   */
  private async persistContentAddressedCopy(
    organizationId: string,
    fingerprint: string,
    fileHandle: fs.promises.FileHandle
  ): Promise<string> {
    const tenantDir = path.join(this.storageBaseDir, organizationId);
    if (!fs.existsSync(tenantDir)) {
      fs.mkdirSync(tenantDir, { recursive: true });
    }

    const casPath = path.join(tenantDir, `${fingerprint}.csv`);
    if (fs.existsSync(casPath)) {
      return casPath;
    }

    const tmpPath = path.join(tenantDir, `${fingerprint}.${Date.now()}.tmp`);
    const writeStream = fs.createWriteStream(tmpPath);
    const readStream = fileHandle.createReadStream({ start: 0, autoClose: false });

    await new Promise<void>((resolve, reject) => {
      readStream.pipe(writeStream);
      writeStream.on('finish', () => resolve());
      writeStream.on('error', (err) => {
        writeStream.destroy();
        reject(err);
      });
      readStream.on('error', (err) => {
        readStream.destroy();
        reject(err);
      });
    });

    try {
      fs.renameSync(tmpPath, casPath);
      // Mark file read-only for tamper resistance
      try {
        fs.chmodSync(casPath, 0o444);
      } catch {
        // Platform fallback
      }
      return casPath;
    } catch (renameErr) {
      if (fs.existsSync(casPath)) {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        return casPath;
      }
      throw renameErr;
    }
  }

  /**
   * Stages a single source file into PostgreSQL in chunked transactions.
   * Guarantees byte-level hash integrity, handles duplicate/retry/incomplete lifecycles,
   * tracks exact physical vs logical record counts, and destroys streams in finally.
   */
  public async stageFile(
    ctx: TenantContext,
    batchId: string,
    rawFilePath: string,
    options?: {
      chunkSize?: number;
      allowedUploadDir?: string;
    }
  ): Promise<SourceFileStagingResult> {
    const totalStartTime = Date.now();
    const timings: SourceFileStagingTiming = {
      hashingMs: 0,
      parsingMs: 0,
      insertionMs: 0,
      totalMs: 0
    };

    // 1. Open secure file handle & validate boundaries
    const secureFile = await this.openSecureFile(rawFilePath, options?.allowedUploadDir);
    const fileName = path.basename(secureFile.canonicalPath);

    try {
      // 2. Stream & compute SHA-256 fingerprint from the open descriptor
      const hashStartTime = Date.now();
      const hash = crypto.createHash('sha256');
      let bytesRead = BigInt(0);

      await new Promise<void>((resolve, reject) => {
        const stream = secureFile.fileHandle.createReadStream({ autoClose: false });
        stream.on('data', (chunk: Buffer | string) => {
          bytesRead += BigInt(Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk));
          hash.update(chunk);
        });
        stream.on('end', () => resolve());
        stream.on('error', (err) => {
          stream.destroy();
          reject(
            new FileCorruptedOrMalformedError(`Failed streaming file '${fileName}': ${err.message}`, {
              cause: err,
              filePath: secureFile.canonicalPath
            })
          );
        });
      });

      timings.hashingMs = Date.now() - hashStartTime;
      const fingerprint = hash.digest('hex');
      const fileSizeBytes = BigInt(secureFile.initialStat.size);

      // Verify file mutation on disk during read
      const postStat = await secureFile.fileHandle.stat();
      if (postStat.size !== secureFile.initialStat.size || postStat.mtimeMs !== secureFile.initialStat.mtimeMs) {
        throw new FileCorruptedOrMalformedError(
          `Source file '${fileName}' was mutated on disk during ingestion (file size or timestamp changed).`,
          { filePath: secureFile.canonicalPath, organizationId: ctx.organizationId, batchId }
        );
      }

      // Persist immutable content-addressed evidence
      let casPath = secureFile.canonicalPath;
      try {
        casPath = await this.persistContentAddressedCopy(ctx.organizationId, fingerprint, secureFile.fileHandle);
      } catch (casErr) {
        logger.warn({
          event: 'CAS_PERSISTENCE_WARNING',
          error: String(casErr)
        }, 'Failed to create CAS copy; using canonical upload path.');
      }

      // 3. Lifecycle-Aware Duplicate & Incomplete File Detection
      const existingFile = await this.sourceRecordRepo.findSourceFileByFingerprint(ctx, fingerprint);
      let sourceFile = existingFile;
      let isRetryOrResume = false;

      if (existingFile) {
        const associations = await this.batchRepo.findBatchSourceFilesBySourceFile(ctx, existingFile.id);

        const isCompleted =
          existingFile.totalPhysicalLines > 0 &&
          associations.some((a) => a.fileStatus === FileBatchStatus.COMPLETED);

        const isCurrentlyProcessing = associations.some(
          (a) => a.fileStatus === FileBatchStatus.PROCESSING && a.importBatchId !== batchId
        );

        if (isCurrentlyProcessing) {
          const activeBatch = associations.find(
            (a) => a.fileStatus === FileBatchStatus.PROCESSING && a.importBatchId !== batchId
          );
          throw new ConcurrentStagingError(
            `Source file '${fileName}' is currently being staged by active batch '${activeBatch?.importBatchId}'. Concurrent staging rejected.`,
            { organizationId: ctx.organizationId, batchId, sourceFileId: existingFile.id }
          );
        }

        if (isCompleted) {
          logger.info({
            event: 'DUPLICATE_SOURCE_FILE_DETECTED',
            fileName,
            fingerprint,
            existingFileId: existingFile.id,
            organizationId: ctx.organizationId,
            batchId
          }, 'Identical source file already completed. Reusing existing source evidence.');

          try {
            await this.batchRepo.associateSourceFile(
              ctx,
              batchId,
              existingFile.id,
              FileBatchStatus.COMPLETED
            );
          } catch (assocErr) {
            if (!(assocErr instanceof DuplicateBatchAssociationError)) {
              throw assocErr;
            }
          }

          const skippedRecords = await this.sourceRecordRepo.countRecordsBySourceFile(ctx, existingFile.id);
          timings.totalMs = Date.now() - totalStartTime;

          return {
            sourceFileId: existingFile.id,
            fileName,
            fileFingerprint: fingerprint,
            fileSizeBytes: existingFile.fileSizeBytes,
            isDuplicate: true,
            reusedExisting: true,
            fileStatus: FileBatchStatus.COMPLETED,
            totalPhysicalLines: existingFile.totalPhysicalLines,
            headerLines: 1,
            parsedLogicalRecords: skippedRecords,
            recordsInserted: 0,
            recordsSkipped: skippedRecords,
            recordsRejected: 0,
            totalDataRecords: skippedRecords,
            durationMs: timings.totalMs,
            timings
          };
        }

        // State 3: INCOMPLETE or FAILED -> resume/retry staging
        logger.warn({
          event: 'INCOMPLETE_SOURCE_FILE_RESUMED',
          fileName,
          fingerprint,
          existingFileId: existingFile.id,
          organizationId: ctx.organizationId,
          batchId
        }, 'Existing source file was incomplete or failed in prior execution. Retrying / resuming staging.');

        try {
          await this.batchRepo.associateSourceFile(
            ctx,
            batchId,
            existingFile.id,
            FileBatchStatus.PROCESSING
          );
        } catch (assocErr) {
          if (assocErr instanceof DuplicateBatchAssociationError) {
            await this.batchRepo.updateBatchSourceFileStatus(
              ctx,
              batchId,
              existingFile.id,
              FileBatchStatus.PROCESSING
            );
          } else {
            throw assocErr;
          }
        }

        sourceFile = existingFile;
        isRetryOrResume = true;
      } else {
        // 4. Register New SourceFile
        try {
          sourceFile = await this.sourceRecordRepo.createSourceFile(ctx, {
            fileName,
            fileFingerprint: fingerprint,
            fileSizeBytes,
            storageUri: casPath,
            sourceReportType: this.inferReportType([], fileName),
            totalPhysicalLines: 0
          });
        } catch (createErr: any) {
          if (createErr instanceof DuplicateSourceFileError) {
            // Concurrent race condition handler
            const racedFile = await this.sourceRecordRepo.findSourceFileByFingerprint(ctx, fingerprint);
            if (racedFile) {
              const racedAssocs = await this.batchRepo.findBatchSourceFilesBySourceFile(ctx, racedFile.id);
              const isRacedActive = racedAssocs.some(
                (a) => a.fileStatus === FileBatchStatus.PROCESSING && a.importBatchId !== batchId
              );

              if (isRacedActive) {
                throw new ConcurrentStagingError(
                  `Source file '${fileName}' was registered concurrently by another active batch. Staging aborted.`,
                  { organizationId: ctx.organizationId, batchId, sourceFileId: racedFile.id }
                );
              }

              sourceFile = racedFile;
              isRetryOrResume = true;
            } else {
              throw createErr;
            }
          } else {
            throw createErr;
          }
        }

        // Associate File with Batch (PROCESSING)
        await this.batchRepo.associateSourceFile(
          ctx,
          batchId,
          sourceFile.id,
          FileBatchStatus.PROCESSING
        );
      }

      // 5. Handle Empty File Safely
      if (fileSizeBytes === BigInt(0)) {
        await this.batchRepo.updateBatchSourceFileStatus(
          ctx,
          batchId,
          sourceFile.id,
          FileBatchStatus.COMPLETED,
          0
        );
        timings.totalMs = Date.now() - totalStartTime;
        return {
          sourceFileId: sourceFile.id,
          fileName,
          fileFingerprint: fingerprint,
          fileSizeBytes,
          isDuplicate: isRetryOrResume,
          reusedExisting: isRetryOrResume,
          fileStatus: FileBatchStatus.COMPLETED,
          totalPhysicalLines: 0,
          headerLines: 0,
          parsedLogicalRecords: 0,
          recordsInserted: 0,
          recordsSkipped: 0,
          recordsRejected: 0,
          totalDataRecords: 0,
          durationMs: timings.totalMs,
          timings
        };
      }

      // 6. Streaming CSV Parsing & Chunked Database Insertion
      const chunkSize = Math.max(
        100,
        Math.min(10000, options?.chunkSize || this.defaultChunkSize)
      );

      const fileStream = fs.createReadStream(casPath, { encoding: 'utf-8' });
      const parser = fileStream.pipe(
        parse({
          columns: true,
          skip_empty_lines: true,
          trim: false,
          relax_column_count: true,
          relax_quotes: true,
          info: true
        })
      );

      let currentChunk: CreateSourceRecordInput[] = [];
      let logicalRecordNumber = 0;
      let totalInserted = 0;
      let totalSkipped = 0;
      let maxPhysicalLine = 0;
      const parseStartTime = Date.now();

      try {
        for await (const chunkData of parser) {
          const { record, info } = chunkData as {
            record: Record<string, string>;
            info: { lines: number; records: number; columns?: any[]; error?: Error };
          };

          logicalRecordNumber++;
          const physicalLine = info.lines;
          if (physicalLine > maxPhysicalLine) {
            maxPhysicalLine = physicalLine;
          }

          const recordType = this.classifyRecordType(
            Object.keys(record),
            record,
            fileName
          );

          currentChunk.push({
            physicalLineNumber: physicalLine,
            logicalRecordNumber,
            recordType,
            rawPayload: record
          });

          if (currentChunk.length >= chunkSize) {
            const insertStart = Date.now();
            const insertResult = await this.sourceRecordRepo.bulkInsertSourceRecords(
              ctx,
              sourceFile.id,
              currentChunk
            );
            timings.insertionMs += Date.now() - insertStart;

            totalInserted += insertResult.insertedCount;
            totalSkipped += insertResult.skippedCount;

            await this.batchRepo.updateBatchSourceFileStatus(
              ctx,
              batchId,
              sourceFile.id,
              FileBatchStatus.PROCESSING,
              totalInserted
            );

            currentChunk = [];
          }
        }

        // Flush remaining chunk
        if (currentChunk.length > 0) {
          const insertStart = Date.now();
          const insertResult = await this.sourceRecordRepo.bulkInsertSourceRecords(
            ctx,
            sourceFile.id,
            currentChunk
          );
          timings.insertionMs += Date.now() - insertStart;

          totalInserted += insertResult.insertedCount;
          totalSkipped += insertResult.skippedCount;
          currentChunk = [];
        }

        timings.parsingMs = Date.now() - parseStartTime - timings.insertionMs;

        // 7. Finalize SourceFile & BatchSourceFile
        await this.batchRepo.updateBatchSourceFileStatus(
          ctx,
          batchId,
          sourceFile.id,
          FileBatchStatus.COMPLETED,
          totalInserted
        );

        await this.sourceRecordRepo.updateSourceFileTotalLines(
          ctx,
          sourceFile.id,
          maxPhysicalLine
        );

        timings.totalMs = Date.now() - totalStartTime;

        logger.info({
          event: 'SOURCE_FILE_STAGED_SUCCESS',
          sourceFileId: sourceFile.id,
          fileName,
          totalPhysicalLines: maxPhysicalLine,
          recordsInserted: totalInserted,
          recordsSkipped: totalSkipped,
          durationMs: timings.totalMs
        }, 'Source file successfully staged into PostgreSQL.');

        return {
          sourceFileId: sourceFile.id,
          fileName,
          fileFingerprint: fingerprint,
          fileSizeBytes,
          isDuplicate: isRetryOrResume,
          reusedExisting: isRetryOrResume,
          fileStatus: FileBatchStatus.COMPLETED,
          totalPhysicalLines: maxPhysicalLine,
          headerLines: maxPhysicalLine > 0 ? 1 : 0,
          parsedLogicalRecords: logicalRecordNumber,
          recordsInserted: totalInserted,
          recordsSkipped: totalSkipped,
          recordsRejected: 0,
          totalDataRecords: logicalRecordNumber,
          durationMs: timings.totalMs,
          timings
        };
      } catch (parseOrInsertErr: any) {
        try {
          await this.batchRepo.updateBatchSourceFileStatus(
            ctx,
            batchId,
            sourceFile.id,
            FileBatchStatus.FAILED,
            totalInserted,
            parseOrInsertErr instanceof Error ? parseOrInsertErr.message : String(parseOrInsertErr)
          );
        } catch (updateErr) {
          logger.error({
            event: 'BATCH_SOURCE_FILE_FAIL_UPDATE_ERROR',
            sourceFileId: sourceFile.id,
            error: String(updateErr)
          }, 'Failed to record FAILED status on batch source file.');
        }

        const isCsvParseError =
          parseOrInsertErr?.code?.startsWith('CSV_') ||
          (parseOrInsertErr instanceof Error &&
            /quote|delimiter|column|invalid/i.test(parseOrInsertErr.message));

        if (isCsvParseError) {
          throw new FileCorruptedOrMalformedError(
            `Failed parsing source file '${fileName}': ${
              parseOrInsertErr instanceof Error ? parseOrInsertErr.message : String(parseOrInsertErr)
            }`,
            {
              cause: parseOrInsertErr,
              organizationId: ctx.organizationId,
              batchId,
              filePath: casPath
            }
          );
        }

        throw new StagingExecutionError(
          `Failed staging source file '${fileName}': ${
            parseOrInsertErr instanceof Error ? parseOrInsertErr.message : String(parseOrInsertErr)
          }`,
          {
            cause: parseOrInsertErr,
            organizationId: ctx.organizationId,
            batchId,
            sourceFileId: sourceFile.id
          }
        );
      } finally {
        fileStream.destroy();
        parser.destroy();
      }
    } finally {
      try {
        await secureFile.fileHandle.close();
      } catch {
        // Ignored if already closed
      }
    }
  }
}
