import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { UploadSanitizer } from '../../../src/modules/imports/upload-sanitizer.js';
import {
  UnsupportedFileTypeError,
  EmptyFileError,
  FileTooLargeError
} from '../../../src/modules/imports/import.errors.js';

describe('Phase 4.2.5: UploadSanitizer Unit Tests', () => {
  const testTempDir = path.resolve('.gstflow_storage', 'test_tmp');
  let sanitizer: UploadSanitizer;

  beforeEach(() => {
    if (fs.existsSync(testTempDir)) {
      fs.rmSync(testTempDir, { recursive: true, force: true });
    }
    sanitizer = new UploadSanitizer({
      tempStorageDir: testTempDir,
      maxFileSizeBytes: 1024 * 1024 // 1 MB for testing
    });
  });

  afterEach(() => {
    if (fs.existsSync(testTempDir)) {
      fs.rmSync(testTempDir, { recursive: true, force: true });
    }
  });

  describe('Filename Sanitization', () => {
    it('normalizes normal filenames safely', () => {
      expect(sanitizer.sanitizeFilename('amazon_mtr_nov_2026.csv')).toBe('amazon_mtr_nov_2026.csv');
    });

    it('strips directory traversal paths', () => {
      expect(sanitizer.sanitizeFilename('../../../etc/passwd.csv')).toBe('passwd.csv');
      expect(sanitizer.sanitizeFilename('..\\..\\windows\\system32\\calc.csv')).toBe('calc.csv');
    });

    it('strips null bytes and control characters', () => {
      expect(sanitizer.sanitizeFilename('report\0.csv')).toBe('report.csv');
      expect(sanitizer.sanitizeFilename("test\r\n\t.csv")).toBe('test.csv');
    });

    it('strips Windows drive prefixes', () => {
      expect(sanitizer.sanitizeFilename('C:\\data\\export.csv')).toBe('export.csv');
    });

    it('falls back to default filename when empty or malicious', () => {
      expect(sanitizer.sanitizeFilename('')).toBe('source_upload.csv');
      expect(sanitizer.sanitizeFilename('...')).toBe('source_upload.csv');
      expect(sanitizer.sanitizeFilename('.csv')).toBe('source_upload.csv');
      expect(sanitizer.sanitizeFilename(undefined)).toBe('source_upload.csv');
    });
  });

  describe('Format and MIME Validation', () => {
    it('accepts valid CSV extension and MIME type', () => {
      expect(() => sanitizer.validateFileFormat('data.csv', 'text/csv')).not.toThrow();
      expect(() => sanitizer.validateFileFormat('data.csv', 'application/vnd.ms-excel')).not.toThrow();
      expect(() => sanitizer.validateFileFormat('data.csv', 'text/plain; charset=utf-8')).not.toThrow();
    });

    it('rejects unsupported file extensions', () => {
      expect(() => sanitizer.validateFileFormat('payload.exe', 'text/csv')).toThrow(UnsupportedFileTypeError);
      expect(() => sanitizer.validateFileFormat('data.xlsx', 'application/vnd.ms-excel')).toThrow(UnsupportedFileTypeError);
      expect(() => sanitizer.validateFileFormat('data.pdf', 'application/pdf')).toThrow(UnsupportedFileTypeError);
    });

    it('rejects unsupported MIME types for csv extension', () => {
      expect(() => sanitizer.validateFileFormat('data.csv', 'application/x-msdownload')).toThrow(UnsupportedFileTypeError);
      expect(() => sanitizer.validateFileFormat('data.csv', 'image/png')).toThrow(UnsupportedFileTypeError);
    });
  });

  describe('Streaming to Temp File & Content Inspection', () => {
    it('streams valid CSV content, computes fingerprint and returns cleanup handler', async () => {
      const csvData = 'Invoice Number,Taxable Value\nINV-001,1000.00\nINV-002,2500.00\n';
      const expectedHash = crypto.createHash('sha256').update(csvData).digest('hex');
      const stream = Readable.from([Buffer.from(csvData)]);

      const result = await sanitizer.streamUploadToTempFile(stream);

      expect(fs.existsSync(result.tempFilePath)).toBe(true);
      expect(result.bytesWritten).toBe(BigInt(Buffer.byteLength(csvData)));
      expect(result.fingerprint).toBe(expectedHash);

      // Verify cleanup
      await result.cleanup();
      expect(fs.existsSync(result.tempFilePath)).toBe(false);
    });

    it('rejects empty uploads (0 bytes) and cleans up temp file', async () => {
      const stream = Readable.from([]);

      await expect(sanitizer.streamUploadToTempFile(stream)).rejects.toThrow(EmptyFileError);

      const files = fs.readdirSync(testTempDir);
      expect(files.length).toBe(0);
    });

    it('rejects uploads exceeding maximum size and cleans up temp file', async () => {
      // Configured max is 1 MB
      const oversizedChunk = Buffer.alloc(1024 * 1024 + 100, 0x61);
      const stream = Readable.from([oversizedChunk]);

      await expect(sanitizer.streamUploadToTempFile(stream)).rejects.toThrow(FileTooLargeError);

      const files = fs.readdirSync(testTempDir);
      expect(files.length).toBe(0);
    });

    it('detects and rejects executable/archive binary magic signatures (e.g. Windows PE / ELF)', async () => {
      // Windows PE executable header: MZ (0x4D, 0x5A)
      const peBuffer = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]);
      const stream = Readable.from([peBuffer]);

      await expect(sanitizer.streamUploadToTempFile(stream)).rejects.toThrow(UnsupportedFileTypeError);

      // ELF header: \x7fELF
      const elfBuffer = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]);
      const stream2 = Readable.from([elfBuffer]);

      await expect(sanitizer.streamUploadToTempFile(stream2)).rejects.toThrow(UnsupportedFileTypeError);
    });
  });
});
