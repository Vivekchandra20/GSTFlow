import { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import crypto from 'crypto';

const REQUEST_ID_HEADER = 'x-request-id';
const MAX_REQUEST_ID_LENGTH = 128;
const SAFE_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

declare module 'fastify' {
  interface FastifyRequest {
    requestId: string;
    startTime: number;
  }
}

const requestContextPlugin: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.decorateRequest('requestId', '');
  fastify.decorateRequest('startTime', 0);

  // 1. Hook onRequest: Resolve or generate request ID
  fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    request.startTime = Date.now();

    const incomingHeader = request.headers[REQUEST_ID_HEADER];
    let resolvedId: string;

    if (
      typeof incomingHeader === 'string' &&
      incomingHeader.length > 0 &&
      incomingHeader.length <= MAX_REQUEST_ID_LENGTH &&
      SAFE_ID_REGEX.test(incomingHeader)
    ) {
      resolvedId = incomingHeader;
    } else {
      resolvedId = crypto.randomUUID();
    }

    request.requestId = resolvedId;
    // Set Fastify's internal request id as well so child loggers inherit it
    request.id = resolvedId;
  });

  // 2. Hook onSend: Always attach x-request-id to response headers
  fastify.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.requestId) {
      reply.header(REQUEST_ID_HEADER, request.requestId);
    }
  });
};

export default fp(requestContextPlugin, {
  name: 'request-context',
  fastify: '5.x'
});
