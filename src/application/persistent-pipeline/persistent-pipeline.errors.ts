/**
 * Base error class for all PersistentPipelineOrchestrator failures.
 * Preserves the original cause error and structured telemetry context.
 */
export abstract class PersistentPipelineError extends Error {
  public readonly code: string;
  public readonly organizationId?: string;
  public readonly batchId?: string;

  constructor(
    message: string,
    options?: {
      code?: string;
      cause?: unknown;
      organizationId?: string;
      batchId?: string;
    }
  ) {
    super(message, options ? { cause: options.cause } : undefined);
    this.name = this.constructor.name;
    this.code = options?.code || 'PERSISTENT_PIPELINE_ERROR';
    this.organizationId = options?.organizationId;
    this.batchId = options?.batchId;
  }
}

/**
 * Thrown when the caller provides an invalid, missing, or malformed tenant context.
 */
export class TenantContextInvalidError extends PersistentPipelineError {
  constructor(
    message: string,
    options?: { cause?: unknown; organizationId?: string }
  ) {
    super(message, {
      code: 'TENANT_CONTEXT_INVALID',
      cause: options?.cause,
      organizationId: options?.organizationId
    });
  }
}

/**
 * Thrown when batch parameters (engine version, rules version, file paths) are invalid.
 */
export class InvalidBatchInputError extends PersistentPipelineError {
  constructor(
    message: string,
    options?: { cause?: unknown; organizationId?: string; batchId?: string }
  ) {
    super(message, {
      code: 'INVALID_BATCH_INPUT',
      cause: options?.cause,
      organizationId: options?.organizationId,
      batchId: options?.batchId
    });
  }
}

/**
 * Thrown when a batch state transition violates the permitted lifecycle state machine.
 */
export class BatchLifecycleError extends PersistentPipelineError {
  constructor(
    message: string,
    options?: { cause?: unknown; organizationId?: string; batchId?: string }
  ) {
    super(message, {
      code: 'BATCH_LIFECYCLE_ERROR',
      cause: options?.cause,
      organizationId: options?.organizationId,
      batchId: options?.batchId
    });
  }
}

/**
 * Thrown when the pure domain pipeline (normalization, routing, reconciliation, validation)
 * encounters an unrecoverable failure during execution.
 */
export class DomainPipelineExecutionError extends PersistentPipelineError {
  constructor(
    message: string,
    options?: { cause?: unknown; organizationId?: string; batchId?: string }
  ) {
    super(message, {
      code: 'DOMAIN_PIPELINE_ERROR',
      cause: options?.cause,
      organizationId: options?.organizationId,
      batchId: options?.batchId
    });
  }
}

/**
 * Thrown when a PostgreSQL or persistence repository operation fails.
 */
export class PersistenceExecutionError extends PersistentPipelineError {
  constructor(
    message: string,
    options?: { cause?: unknown; organizationId?: string; batchId?: string }
  ) {
    super(message, {
      code: 'PERSISTENCE_ERROR',
      cause: options?.cause,
      organizationId: options?.organizationId,
      batchId: options?.batchId
    });
  }
}

/**
 * Thrown when an unexpected infrastructure or system error occurs.
 */
export class InfrastructureExecutionError extends PersistentPipelineError {
  constructor(
    message: string,
    options?: { cause?: unknown; organizationId?: string; batchId?: string }
  ) {
    super(message, {
      code: 'INFRASTRUCTURE_ERROR',
      cause: options?.cause,
      organizationId: options?.organizationId,
      batchId: options?.batchId
    });
  }
}

/**
 * Thrown when a specified source file path does not exist, is inaccessible, or violates path security boundaries.
 */
export class SourceFileNotFoundOrInaccessibleError extends PersistentPipelineError {
  public readonly filePath?: string;

  constructor(
    message: string,
    options?: { cause?: unknown; organizationId?: string; batchId?: string; filePath?: string }
  ) {
    super(message, {
      code: 'INVALID_SOURCE_FILE_PATH',
      cause: options?.cause,
      organizationId: options?.organizationId,
      batchId: options?.batchId
    });
    this.filePath = options?.filePath;
  }
}

/**
 * Thrown when a source file is corrupted, unreadable, or cannot be parsed as CSV.
 */
export class FileCorruptedOrMalformedError extends PersistentPipelineError {
  public readonly filePath?: string;

  constructor(
    message: string,
    options?: { cause?: unknown; organizationId?: string; batchId?: string; filePath?: string }
  ) {
    super(message, {
      code: 'MALFORMED_SOURCE_FILE',
      cause: options?.cause,
      organizationId: options?.organizationId,
      batchId: options?.batchId
    });
    this.filePath = options?.filePath;
  }
}

/**
 * Thrown when chunked persistence or staging execution fails.
 */
export class StagingExecutionError extends PersistentPipelineError {
  public readonly sourceFileId?: string;

  constructor(
    message: string,
    options?: {
      cause?: unknown;
      organizationId?: string;
      batchId?: string;
      sourceFileId?: string;
    }
  ) {
    super(message, {
      code: 'STAGING_ERROR',
      cause: options?.cause,
      organizationId: options?.organizationId,
      batchId: options?.batchId
    });
    this.sourceFileId = options?.sourceFileId;
  }
}



/**
 * Thrown when attempting to consume an incomplete or partially staged source file.
 */
export class IncompleteSourceFileError extends PersistentPipelineError {
  public readonly sourceFileId?: string;

  constructor(
    message: string,
    options?: {
      cause?: unknown;
      organizationId?: string;
      batchId?: string;
      sourceFileId?: string;
    }
  ) {
    super(message, {
      code: 'INCOMPLETE_SOURCE_FILE',
      cause: options?.cause,
      organizationId: options?.organizationId,
      batchId: options?.batchId
    });
    this.sourceFileId = options?.sourceFileId;
  }
}

/**
 * Thrown when an identical source file is currently being staged concurrently by another process or batch.
 */
export class ConcurrentStagingError extends PersistentPipelineError {
  public readonly sourceFileId?: string;

  constructor(
    message: string,
    options?: {
      cause?: unknown;
      organizationId?: string;
      batchId?: string;
      sourceFileId?: string;
    }
  ) {
    super(message, {
      code: 'CONCURRENT_STAGING_CONFLICT',
      cause: options?.cause,
      organizationId: options?.organizationId,
      batchId: options?.batchId
    });
    this.sourceFileId = options?.sourceFileId;
  }
}

/**
 * Thrown when attempting to execute domain processing on a batch whose source files are not all COMPLETED.
 */
export class BatchNotReadyForProcessingError extends PersistentPipelineError {
  constructor(
    message: string,
    options?: { cause?: unknown; organizationId?: string; batchId?: string }
  ) {
    super(message, {
      code: 'BATCH_NOT_READY_FOR_PROCESSING',
      cause: options?.cause,
      organizationId: options?.organizationId,
      batchId: options?.batchId
    });
  }
}

/**
 * Thrown when worker authorization fails or organization identity does not match authoritative records.
 */
export class TenantAuthorizationError extends PersistentPipelineError {
  constructor(
    message: string,
    options?: { cause?: unknown; organizationId?: string; batchId?: string }
  ) {
    super(message, {
      code: 'TENANT_AUTHORIZATION_ERROR',
      cause: options?.cause,
      organizationId: options?.organizationId,
      batchId: options?.batchId
    });
  }
}


