export abstract class GstRegistrationError extends Error {
  abstract readonly statusCode: number;
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class GstRegistrationNotFoundError extends GstRegistrationError {
  readonly statusCode = 404;
  readonly code = 'GST_REGISTRATION_NOT_FOUND';

  constructor(message: string = 'GST registration not found in the specified organization.') {
    super(message);
  }
}

export class DuplicateGstinRegistrationError extends GstRegistrationError {
  readonly statusCode = 409;
  readonly code = 'DUPLICATE_GSTIN_REGISTRATION';

  constructor(gstin: string) {
    super(`A GST registration with GSTIN '${gstin}' already exists in this organization.`);
  }
}

export class InvalidGstinError extends GstRegistrationError {
  readonly statusCode = 400;
  readonly code = 'INVALID_GSTIN';
  readonly details: string[];

  constructor(message: string, details: string[] = []) {
    super(message);
    this.details = details;
  }
}

export class PanMismatchError extends GstRegistrationError {
  readonly statusCode = 400;
  readonly code = 'PAN_MISMATCH';

  constructor(gstinPan: string, orgPan: string) {
    super(
      `GSTIN PAN component '${gstinPan}' does not match organization PAN '${orgPan}'. All GSTINs of an organization must share the same entity PAN.`
    );
  }
}

export class InvalidGstRegistrationStatusTransitionError extends GstRegistrationError {
  readonly statusCode = 409;
  readonly code = 'INVALID_STATUS_TRANSITION';

  constructor(fromStatus: string, toStatus: string) {
    super(`Cannot transition GST registration status from '${fromStatus}' to '${toStatus}'.`);
  }
}
