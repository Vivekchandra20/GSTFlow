import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { validatorCompiler, serializerCompiler } from 'fastify-type-provider-zod';

const validationPlugin: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.setValidatorCompiler(validatorCompiler);
  fastify.setSerializerCompiler(serializerCompiler);
};

export default fp(validationPlugin, {
  name: 'zod-validation',
  fastify: '5.x'
});
