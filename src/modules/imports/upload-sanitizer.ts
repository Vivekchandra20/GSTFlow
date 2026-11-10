import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  UnsupportedFileTypeError,
  EmptyFileError,
  FileTooLargeError,
  MalformedUploadError
} from './import.errors.js';

export interface UploadSanitizerOptions {
  maxFileSizeBytes?: number;
  tempStorageDir?: string;
  allowedExtensions?: string[];
  allowedMimeTypes?: string[];
}

export interface StreamedUploadResult {
  tempFilePath: string;
  fingerprint: string;
  bytesWritten: bigint;
  cleanup: () => Promise<void>;
}

const DEFAULT_MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const DEFAULT_TEMP_DIR = path.resolve('.gstflow_storage', 'tmp');

const ALLOWED_EXTENSIONS = new Set(['.csv']);

const ALLOWED_MIME_TYPES = new Set([
  'text/csv',
  'text/plain',
  'application/csv',
  'application/vnd.ms-excel',
  'text/x-csv',
  'application/octet-stream',
  'text/comma-separated-values'
]);

// Binary magic bytes signatures to reject immediately
const DISALLOWED_MAGIC_SIGNATURES: Array<{ name: string; bytes: number[] }> = [
  { name: 'ELF executable', bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { name: 'Windows executable / PE', bytes: [0x4d, 0x5a] },
  { name: 'ZIP / Office archive', bytes: [0x50, 0x4b, 0x03, 0x04] },
  { name: 'GZIP archive', bytes: [0x1f, 0x8b] },
  { name: 'PDF document', bytes: [0x25, 0x50, 0x44, 0x46] }
];

export class UploadSanitizer {
  private readonly maxFileSizeBytes: number;
  private readonly tempStorageDir: string;

  constructor(options?: UploadSanitizerOptions) {
    this.maxFileSizeBytes = options?.maxFileSizeBytes || DEFAULT_MAX_FILE_SIZE;
    this.tempStorageDir = path.resolve(options?.tempStorageDir || DEFAULT_TEMP_DIR);

    if (!fs.existsSync(this.tempStorageDir)) {
      fs.mkdirSync(this.tempStorageDir, { recursive: true });
    }
  }

  /**
   * Sanitizes user-provided filename to prevent directory traversal, null byte injections,
   * absolute path overwriting, and control character attacks.
   */
  public sanitizeFilename(rawFilename?: string): string {
    if (!rawFilename || typeof rawFilename !== 'string') {
      return 'source_upload.csv';
    }

    // Strip control characters, null bytes, and path separators
    let cleaned = rawFilename
      .replace(/\0/g, '')
      .replace(/[\r\n\t]/g, '')
      .trim();

    // Use basename to prevent directory traversal
    cleaned = path.basename(cleaned);

    // Strip Windows drive letters (e.g. C:)
    cleaned = cleaned.replace(/^[a-zA-Z]:/, '');

    // Replace sequences of unsafe filesystem characters
    cleaned = cleaned.replace(/[^a-zA-Z0-9._\-]/g, '_');

    // Prevent hidden files and empty strings
    cleaned = cleaned.replace(/^\.+/, '');

    if (!cleaned || cleaned === '' || cleaned === '.csv' || cleaned === 'csv') {
      return 'source_upload.csv';
    }

    return cleaned;
  }

  /**
   * Validates file extension and reported MIME type.
   */
  public validateFileFormat(filename: string, mimetype?: string): void {
    const ext = path.extname(filename).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      throw new UnsupportedFileTypeError(`Unsupported file extension '${ext}'. Only .csv files are supported.`);
    }

    if (mimetype) {
      const normalizedMime = mimetype.toLowerCase().split(';')[0].trim();
      if (!ALLOWED_MIME_TYPES.has(normalizedMime)) {
        throw new UnsupportedFileTypeError(
          `Unsupported MIME type '${mimetype}'. Permitted types are CSV or text-based table formats.`
        );
      }
    }
  }

  /**
   * Memory-bounded streaming of incoming multipart upload to a temporary file.
   * Computes SHA-256 fingerprint on-the-fly, enforces size limits, inspects binary signatures,
   * and provides a safe cleanup method.
   */
  public async streamUploadToTempFile(
    fileStream: Readable | any
  ): Promise<StreamedUploadResult> {
    const tempFileId = crypto.randomUUID();
    const tempFilePath = path.join(this.tempStorageDir, `upload_${tempFileId}.tmp`);

    const writeStream = fs.createWriteStream(tempFilePath, { flags: 'wx', mode: 0o600 });
    const hash = crypto.createHash('sha256');

    let bytesWritten = BigInt(0);
    let firstChunk: Buffer | null = null;
    let sizeLimitExceeded = false;

    const cleanup = async (): Promise<void> => {
      if (!writeStream.closed) {
        await new Promise<void>((resolve) => {
          writeStream.once('close', () => resolve());
          writeStream.destroy();
        });
      }
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          if (fs.existsSync(tempFilePath)) {
            await fs.promises.unlink(tempFilePath);
          }
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 25));
        }
      }
    };

    try {
      await new Promise<void>((resolve, reject) => {
        fileStream.on('data', (chunk: Buffer | string) => {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

          if (!firstChunk && buf.length > 0) {
            firstChunk = buf.subarray(0, 16);
          }

          bytesWritten += BigInt(buf.length);
          if (bytesWritten > BigInt(this.maxFileSizeBytes)) {
            sizeLimitExceeded = true;
            fileStream.destroy();
            writeStream.destroy();
            return reject(new FileTooLargeError(this.maxFileSizeBytes, Number(bytesWritten)));
          }

          hash.update(buf);
          const ok = writeStream.write(buf);
          if (!ok) {
            fileStream.pause();
            writeStream.once('drain', () => fileStream.resume());
          }
        });

        fileStream.on('end', () => {
          writeStream.end(() => resolve());
        });

        fileStream.on('error', (err: any) => {
          writeStream.destroy();
          reject(new MalformedUploadError(`Stream interrupted during upload: ${err.message}`));
        });

        writeStream.on('error', (err: any) => {
          fileStream.destroy();
          reject(err);
        });
      });

      // 1. Verify empty file
      if (bytesWritten === BigInt(0)) {
        await cleanup();
        throw new EmptyFileError();
      }

      // 2. Inspect first chunk for disallowed executable/archive binary signatures
      if (firstChunk) {
        for (const sig of DISALLOWED_MAGIC_SIGNATURES) {
          const chunkHeader = (firstChunk as Buffer).subarray(0, sig.bytes.length);
          const matches = sig.bytes.every((b, idx) => chunkHeader[idx] === b);
          if (matches) {
            await cleanup();
            throw new UnsupportedFileTypeError(
              `Uploaded file contains binary signature for '${sig.name}'. Only plain text CSV files are permitted.`
            );
          }
        }
      }

      const fingerprint = hash.digest('hex');

      return {
        tempFilePath,
        fingerprint,
        bytesWritten,
        cleanup
      };
    } catch (err) {
      await cleanup();
      throw err;
    }
  }
}
