import { z } from 'zod';
import { Decimal } from '../utils/decimal.js';
import { DecimalSchema } from './transaction.schema.js';
import { SupplyType } from './enums.js';

export interface TcsRateSchedule {
  rateId: string;
  name: string;
  totalRate: Decimal;      // Combined rate percentage
  cgstRate: Decimal;       // Half of total rate for intrastate
  sgstRate: Decimal;       // Half of total rate for intrastate (State)
  utgstRate: Decimal;      // Half of total rate for intrastate (UT)
  igstRate: Decimal;       // Equal to total rate for interstate
  effectiveFrom: string;   // YYYY-MM-DD
  effectiveTo?: string;    // YYYY-MM-DD
  notificationReference: string;
}

export const TcsBreakdownSchema = z.object({
  netTaxableValue: DecimalSchema, // Gross taxable value minus sales returns
  totalTcsRate: DecimalSchema,
  cgstTcsRate: DecimalSchema,
  cgstTcsAmount: DecimalSchema,
  sgstTcsRate: DecimalSchema,
  sgstTcsAmount: DecimalSchema,
  utgstTcsRate: DecimalSchema,
  utgstTcsAmount: DecimalSchema,
  igstTcsRate: DecimalSchema,
  igstTcsAmount: DecimalSchema,
  totalTcsAmount: DecimalSchema,
  effectiveNotification: z.string()
});

export type TcsBreakdown = z.infer<typeof TcsBreakdownSchema>;
