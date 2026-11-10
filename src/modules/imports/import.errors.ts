export abstract class ImportError extends Error {
  public abstract readonly statusCode: number;
  public abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ImportNotFoundError extends ImportError {
  public readonly statusCode = 404;
  public readonly code = 'IMPORT_NOT_FOUND';

  constructor(batchId: string, organizationId?: string) {
    super(`Import batch '${batchId}' was not found in organization${organizationId ? ` '${organizationId}'` : ''}.`);
  }
}

export class DuplicateImportError extends ImportError {
  public readonly statusCode = 409;
  public readonly code: string;
  public readonly details: Record<string, unknown>;

  constructor(message: string, code: string = 'DUPLICATE_IMPORT', details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export class UnsupportedFileTypeError extends ImportError {
  public readonly statusCode = 400;
  public readonly code = 'UNSUPPORTED_FILE_TYPE';

  constructor(message: string = 'Only CSV files (.csv) are supported for source imports.') {
    super(message);
  }
}

export class EmptyFileError extends ImportError {
  public readonly statusCode = 400;
  public readonly code = 'EMPTY_FILE';

  constructor(message: string = 'Uploaded source file is empty (0 bytes).') {
    super(message);
  }
}

export class FileTooLargeError extends ImportError {
  public readonly statusCode = 413;
  public readonly code = 'FILE_TOO_LARGE';
  public readonly details: { maxSizeBytes: number; actualSizeBytes?: number };

  constructor(maxSizeBytes: number, actualSizeBytes?: number) {
    super(`Uploaded file exceeds the maximum permitted size of ${Math.round(maxSizeBytes / (1024 * 1024))}MB.`);
    this.details = { maxSizeBytes, actualSizeBytes };
  }
}

export class MalformedUploadError extends ImportError {
  public readonly statusCode = 400;
  public readonly code = 'MALFORMED_UPLOAD';

  constructor(message: string) {
    super(message);
  }
}

export class GstRegistrationNotEligibleError extends ImportError {
  public readonly statusCode = 400;
  public readonly code = 'GST_REGISTRATION_NOT_ELIGIBLE';
  public readonly details: { gstRegistrationId: string; status?: string; reason: string };

  constructor(gstRegistrationId: string, reason: string, status?: string) {
    super(`GST registration '${gstRegistrationId}' is not eligible for imports: ${reason}`);
    this.details = { gstRegistrationId, status, reason };
  }
}

export class ImportCancellationError extends ImportError {
  public readonly statusCode = 409;
  public readonly code = 'IMPORT_CANCELLATION_NOT_ALLOWED';

  constructor(message: string) {
    super(message);
  }
}

export class ImportProcessingError extends ImportError {
  public readonly statusCode = 500;
  public readonly code = 'IMPORT_PROCESSING_ERROR';

  constructor(message: string, public readonly cause?: unknown) {
    super(message);
  }
}
