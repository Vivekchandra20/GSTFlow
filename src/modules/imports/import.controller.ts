import { FastifyRequest, FastifyReply } from 'fastify';
import { ImportService } from './import.service.js';
import { UploadSanitizer } from './upload-sanitizer.js';
import { TenantContext } from '../../repositories/types.js';
import { SourcePlatform } from './import.types.js';
import { MalformedUploadError } from './import.errors.js';
import { listImportsQuerySchema } from './import.schemas.js';

export class ImportController {
  private readonly sanitizer: UploadSanitizer;

  constructor(
    private readonly importService: ImportService,
    sanitizer?: UploadSanitizer
  ) {
    this.sanitizer = sanitizer || new UploadSanitizer();
  }

  public handleUploadAndCreateImport = async (
    request: FastifyRequest<any>,
    reply: FastifyReply
  ): Promise<void> => {
    const requestId = request.requestId || (request.id as string) || 'unknown';
    const { organizationId } = request.params as { organizationId: string };
    const ctx: TenantContext = { organizationId };

    if (!request.isMultipart()) {
      throw new MalformedUploadError('Request must be multipart/form-data.');
    }

    const parts = request.parts();
    let fileStream: any = null;
    let rawFilename: string | undefined;
    let mimetype: string | undefined;
    const fields: Record<string, string> = {};

    let streamResult: { tempFilePath: string; fingerprint: string; bytesWritten: bigint; cleanup: () => Promise<void> } | null = null;

    try {
      for await (const part of parts) {
        if (part.type === 'file') {
          if (fileStream) {
            // Already received a file part: only one file is permitted per upload
            part.file.resume(); // Drain and discard extra file
            continue;
          }
          fileStream = part.file;
          rawFilename = part.filename;
          mimetype = part.mimetype;

          // Validate file format immediately
          const cleanFilename = this.sanitizer.sanitizeFilename(rawFilename);
          this.sanitizer.validateFileFormat(cleanFilename, mimetype);

          // Stream into temp file
          streamResult = await this.sanitizer.streamUploadToTempFile(fileStream);
        } else {
          fields[part.fieldname] = part.value as string;
        }
      }

      if (!fileStream || !streamResult) {
        throw new MalformedUploadError('Multipart request did not include a source file.');
      }

      const gstRegistrationId = fields.gstRegistrationId?.trim();
      if (!gstRegistrationId) {
        throw new MalformedUploadError("Field 'gstRegistrationId' is required.");
      }

      let sourcePlatform: SourcePlatform = 'AMAZON';
      if (fields.sourcePlatform) {
        const platformUpper = fields.sourcePlatform.toUpperCase();
        if (['AMAZON', 'FLIPKART', 'MEESHO', 'CUSTOM'].includes(platformUpper)) {
          sourcePlatform = platformUpper as SourcePlatform;
        } else {
          throw new MalformedUploadError(`Invalid sourcePlatform '${fields.sourcePlatform}'.`);
        }
      }

      let metadata: Record<string, unknown> | undefined;
      if (fields.metadata) {
        try {
          metadata = JSON.parse(fields.metadata);
        } catch {
          throw new MalformedUploadError("Field 'metadata' must be valid JSON.");
        }
      }

      const cleanFilename = this.sanitizer.sanitizeFilename(rawFilename);

      const importResult = await this.importService.createImport(ctx, {
        gstRegistrationId,
        sourcePlatform,
        originalFileName: cleanFilename,
        tempFilePath: streamResult.tempFilePath,
        fileSizeBytes: streamResult.bytesWritten,
        fingerprint: streamResult.fingerprint,
        metadata
      });

      return reply.status(201).send({
        success: true,
        data: importResult,
        requestId
      });
    } finally {
      if (streamResult) {
        await streamResult.cleanup();
      }
    }
  };

  public handleListImports = async (
    request: FastifyRequest<any>,
    reply: FastifyReply
  ): Promise<void> => {
    const requestId = request.requestId || (request.id as string) || 'unknown';
    const { organizationId } = request.params as { organizationId: string };
    const ctx: TenantContext = { organizationId };

    const parsedQuery = listImportsQuerySchema.parse(request.query || {});
    const result = await this.importService.listImports(ctx, parsedQuery);

    return reply.status(200).send({
      success: true,
      data: result,
      requestId
    });
  };

  public handleGetImport = async (
    request: FastifyRequest<any>,
    reply: FastifyReply
  ): Promise<void> => {
    const requestId = request.requestId || (request.id as string) || 'unknown';
    const { organizationId, batchId } = request.params as { organizationId: string; batchId: string };
    const ctx: TenantContext = { organizationId };

    const result = await this.importService.getImport(ctx, batchId);

    return reply.status(200).send({
      success: true,
      data: result,
      requestId
    });
  };

  public handleGetImportStatus = async (
    request: FastifyRequest<any>,
    reply: FastifyReply
  ): Promise<void> => {
    const requestId = request.requestId || (request.id as string) || 'unknown';
    const { organizationId, batchId } = request.params as { organizationId: string; batchId: string };
    const ctx: TenantContext = { organizationId };

    const result = await this.importService.getImportStatus(ctx, batchId);

    return reply.status(200).send({
      success: true,
      data: result,
      requestId
    });
  };

  public handleGetImportSummary = async (
    request: FastifyRequest<any>,
    reply: FastifyReply
  ): Promise<void> => {
    const requestId = request.requestId || (request.id as string) || 'unknown';
    const { organizationId, batchId } = request.params as { organizationId: string; batchId: string };
    const ctx: TenantContext = { organizationId };

    const result = await this.importService.getImportSummary(ctx, batchId);

    return reply.status(200).send({
      success: true,
      data: result,
      requestId
    });
  };
}
