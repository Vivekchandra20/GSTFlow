import { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { ZodError } from 'zod';
import { TenantAuthorizationError } from '../../repositories/types.js';
import { AuthError } from '../../modules/auth/auth.errors.js';
import { AuthorizationError } from '../../modules/authorization/authorization.errors.js';
import { GstRegistrationError } from '../../modules/gst-registrations/gst-registration.errors.js';
import { ImportError } from '../../modules/imports/import.errors.js';

export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: Array<Record<string, any>> | string[];
  };
  requestId: string;
}

const errorHandlerPlugin: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // 1. Centralized Fastify Error Handler
  fastify.setErrorHandler((error: any, request: FastifyRequest, reply: FastifyReply) => {
    const requestId = request.requestId || (request.id as string) || 'unknown';
    const isProd = process.env.NODE_ENV === 'production';

    let statusCode = error.statusCode || 500;
    let errorCode = 'INTERNAL_SERVER_ERROR';
    let errorMessage = 'An unexpected internal server error occurred';
    let errorDetails: Array<Record<string, any>> | undefined = undefined;

    // A. Handle Zod validation errors
    if (error instanceof ZodError) {
      statusCode = 400;
      errorCode = 'VALIDATION_ERROR';
      errorMessage = 'Request validation failed';
      errorDetails = error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message
      }));
    }
    // B. Handle Fastify schema validation errors
    else if (error.code === 'FST_ERR_VALIDATION') {
      statusCode = 400;
      errorCode = 'VALIDATION_ERROR';
      errorMessage = 'Request validation failed';
      if (Array.isArray(error.validation)) {
        errorDetails = error.validation.map((v: any) => ({
          field: v.instancePath || v.params?.missingProperty || '',
          message: v.message || 'Invalid field'
        }));
      }
    }
    // C. Handle Malformed JSON or Content-Type body errors
    else if (
      error.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' ||
      error.code === 'FST_ERR_CTP_EMPTY_JSON_BODY' ||
      error.code === 'FST_ERR_CTP_INVALID_JSON_BODY' ||
      (error instanceof SyntaxError && (error as any).status === 400)
    ) {
      statusCode = 400;
      errorCode = 'MALFORMED_REQUEST';
      errorMessage = 'Malformed or invalid JSON request body';
    }
    // D. Handle Payload Too Large
    else if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      statusCode = 413;
      errorCode = 'PAYLOAD_TOO_LARGE';
      errorMessage = 'Request body exceeds maximum allowed size';
    }
    // E. Handle Authentication and Identity Errors
    else if (error instanceof AuthError) {
      statusCode = error.statusCode;
      errorCode = error.code;
      errorMessage = error.message;
    }
    // F. Handle Organization Authorization and RBAC Errors
    else if (error instanceof AuthorizationError) {
      statusCode = error.statusCode;
      errorCode = error.code;
      errorMessage = error.message;
    }
    // G. Handle GST Registration Errors
    else if (error instanceof GstRegistrationError) {
      statusCode = error.statusCode;
      errorCode = error.code;
      errorMessage = error.message;
      if ('details' in error && Array.isArray((error as any).details)) {
        errorDetails = (error as any).details.map((d: string) => ({ message: d }));
      }
    }
    // G2. Handle Source File Upload & Import Errors (Phase 4.2.5)
    else if (error instanceof ImportError) {
      statusCode = error.statusCode;
      errorCode = error.code;
      errorMessage = error.message;
      if ('details' in error && (error as any).details) {
        errorDetails = Array.isArray((error as any).details)
          ? (error as any).details
          : [(error as any).details];
      }
    }
    // H. Handle Tenant Authorization Errors
    else if (error instanceof TenantAuthorizationError || error.name === 'TenantAuthorizationError') {
      statusCode = 403;
      errorCode = 'TENANT_AUTHORIZATION_ERROR';
      errorMessage = isProd
        ? 'Access denied for the specified organization'
        : error.message;
    }
    // G. Handle Not Found errors (e.g. 404 from explicit throw or domain error)
    else if (statusCode === 404 || error.name?.includes('NotFoundError')) {
      statusCode = 404;
      errorCode = 'NOT_FOUND';
      errorMessage = error.message || 'Resource not found';
    }
    // H. Handle General Client Errors (4xx)
    else if (statusCode >= 400 && statusCode < 500) {
      errorCode = error.code || 'BAD_REQUEST';
      errorMessage = error.message || 'Bad Request';
    }
    // H. Internal Server Errors (5xx)
    else {
      statusCode = 500;
      errorCode = 'INTERNAL_SERVER_ERROR';
      // In development or test, we may expose error.message for faster debugging, but NEVER in production
      errorMessage = isProd
        ? 'An unexpected internal server error occurred'
        : (error.message || 'An unexpected internal server error occurred');
    }

    // Always log the error internally with full details and request context
    if (statusCode >= 500) {
      request.log.error(
        {
          err: {
            message: error.message,
            stack: error.stack,
            code: error.code
          },
          requestId,
          url: request.url,
          method: request.method,
          statusCode
        },
        'Unhandled server error occurred'
      );
    } else {
      request.log.warn(
        {
          requestId,
          errorCode,
          statusCode,
          url: request.url,
          method: request.method,
          message: error.message
        },
        'Client error occurred'
      );
    }

    const responseBody: ApiErrorResponse = {
      success: false,
      error: {
        code: errorCode,
        message: errorMessage,
        ...(errorDetails && errorDetails.length > 0 ? { details: errorDetails } : {})
      },
      requestId
    };

    reply.status(statusCode).send(responseBody);
  });

  // 2. Custom 404 Not Found Handler for unknown routes
  fastify.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const requestId = request.requestId || (request.id as string) || 'unknown';

    const responseBody: ApiErrorResponse = {
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: `Route ${request.method} ${request.url} not found`
      },
      requestId
    };

    reply.status(404).send(responseBody);
  });
};

export default fp(errorHandlerPlugin, {
  name: 'error-handler',
  fastify: '5.x'
});
