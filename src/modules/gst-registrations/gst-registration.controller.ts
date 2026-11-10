import { FastifyRequest, FastifyReply } from 'fastify';
import { GstRegistrationService } from './gst-registration.service.js';
import {
  CreateGstRegistrationBody,
  UpdateGstRegistrationBody,
  UpdateGstRegistrationStatusBody,
  ListGstRegistrationsQuery,
  GstRegistrationParams
} from './gst-registration.schemas.js';

export class GstRegistrationController {
  constructor(private readonly service: GstRegistrationService) {}

  public createRegistration = async (
    request: FastifyRequest<any>,
    reply: FastifyReply
  ): Promise<void> => {
    const { organizationId } = request.params as GstRegistrationParams;
    const body = request.body as CreateGstRegistrationBody;

    const registration = await this.service.createRegistration(organizationId, body);

    reply.status(201).send({
      success: true,
      data: {
        gstRegistration: registration
      }
    });
  };

  public listRegistrations = async (
    request: FastifyRequest<any>,
    reply: FastifyReply
  ): Promise<void> => {
    const { organizationId } = request.params as GstRegistrationParams;
    const query = (request.query || {}) as ListGstRegistrationsQuery;

    const result = await this.service.listRegistrations(organizationId, query);

    reply.status(200).send({
      success: true,
      data: result
    });
  };

  public getRegistration = async (
    request: FastifyRequest<any>,
    reply: FastifyReply
  ): Promise<void> => {
    const { organizationId, gstRegistrationId } = request.params as {
      organizationId: string;
      gstRegistrationId: string;
    };

    const registration = await this.service.getRegistration(organizationId, gstRegistrationId);

    reply.status(200).send({
      success: true,
      data: {
        gstRegistration: registration
      }
    });
  };

  public updateRegistration = async (
    request: FastifyRequest<any>,
    reply: FastifyReply
  ): Promise<void> => {
    const { organizationId, gstRegistrationId } = request.params as {
      organizationId: string;
      gstRegistrationId: string;
    };
    const body = request.body as UpdateGstRegistrationBody;

    const registration = await this.service.updateRegistration(
      organizationId,
      gstRegistrationId,
      body
    );

    reply.status(200).send({
      success: true,
      data: {
        gstRegistration: registration
      }
    });
  };

  public updateRegistrationStatus = async (
    request: FastifyRequest<any>,
    reply: FastifyReply
  ): Promise<void> => {
    const { organizationId, gstRegistrationId } = request.params as {
      organizationId: string;
      gstRegistrationId: string;
    };
    const body = request.body as UpdateGstRegistrationStatusBody;

    const registration = await this.service.updateRegistrationStatus(
      organizationId,
      gstRegistrationId,
      body
    );

    reply.status(200).send({
      success: true,
      data: {
        gstRegistration: registration
      }
    });
  };
}
