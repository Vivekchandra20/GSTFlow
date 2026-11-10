import { Decimal, roundToTwo } from '../utils/decimal.js';
import { SupplyType } from '../models/enums.js';
import { isUTGSTApplicable } from '../utils/state-codes.js';
import { TcsBreakdown, TcsRateSchedule } from '../models/tcs.js';

export class TcsCalculator {
  private static schedules: TcsRateSchedule[] = [
    // Historical rate: 01 July 2017 to 09 July 2024 (Notification No. 52/2018-Central Tax)
    {
      rateId: 'TCS-1.0',
      name: 'Pre-July 2024 TCS Schedule (1.0% total)',
      totalRate: new Decimal('1.0'),
      cgstRate: new Decimal('0.5'),
      sgstRate: new Decimal('0.5'),
      utgstRate: new Decimal('0.5'),
      igstRate: new Decimal('1.0'),
      effectiveFrom: '2017-07-01',
      effectiveTo: '2024-07-09',
      notificationReference: 'Notification No. 52/2018-Central Tax & 02/2018-Integrated Tax'
    },
    // Current rate: 10 July 2024 onwards (Notification No. 15/2024-Central Tax & 01/2024-Integrated Tax)
    {
      rateId: 'TCS-0.5',
      name: 'Post-July 2024 TCS Schedule (0.5% total)',
      totalRate: new Decimal('0.5'),
      cgstRate: new Decimal('0.25'),
      sgstRate: new Decimal('0.25'),
      utgstRate: new Decimal('0.25'),
      igstRate: new Decimal('0.5'),
      effectiveFrom: '2024-07-10',
      notificationReference: 'Notification No. 15/2024-Central Tax & 01/2024-Integrated Tax'
    }
  ];

  /**
   * Find matching TCS schedule for a given transaction date.
   */
  public static getScheduleForDate(dateStr: string): TcsRateSchedule {
    for (const schedule of this.schedules) {
      if (schedule.effectiveFrom <= dateStr && (!schedule.effectiveTo || schedule.effectiveTo >= dateStr)) {
        return schedule;
      }
    }
    // Default to the latest active schedule if out of range
    return this.schedules[this.schedules.length - 1];
  }

  /**
   * Calculates Section 52 Tax Collected at Source (TCS) independently from ordinary output GST.
   * Net Taxable Value = Gross taxable supplies minus sales returns/cancellations.
   */
  public static calculateTcs(
    netTaxableValue: Decimal,
    supplyType: SupplyType,
    shipFromStateCode: string,
    transactionDateStr: string
  ): TcsBreakdown {
    const netValue = roundToTwo(netTaxableValue);
    const schedule = this.getScheduleForDate(transactionDateStr);

    let cgstRate = new Decimal(0);
    let cgstAmount = new Decimal(0);
    let sgstRate = new Decimal(0);
    let sgstAmount = new Decimal(0);
    let utgstRate = new Decimal(0);
    let utgstAmount = new Decimal(0);
    let igstRate = new Decimal(0);
    let igstAmount = new Decimal(0);

    if (supplyType === SupplyType.INTRASTATE) {
      cgstRate = schedule.cgstRate;
      cgstAmount = roundToTwo(netValue.mul(cgstRate).div(new Decimal(100)));

      if (isUTGSTApplicable(shipFromStateCode)) {
        utgstRate = schedule.utgstRate;
        utgstAmount = roundToTwo(netValue.mul(utgstRate).div(new Decimal(100)));
      } else {
        sgstRate = schedule.sgstRate;
        sgstAmount = roundToTwo(netValue.mul(sgstRate).div(new Decimal(100)));
      }
    } else if (supplyType === SupplyType.INTERSTATE) {
      igstRate = schedule.igstRate;
      igstAmount = roundToTwo(netValue.mul(igstRate).div(new Decimal(100)));
    }

    const totalTcsAmount = cgstAmount.add(sgstAmount).add(utgstAmount).add(igstAmount);

    return {
      netTaxableValue: netValue,
      totalTcsRate: schedule.totalRate,
      cgstTcsRate: cgstRate,
      cgstTcsAmount: cgstAmount,
      sgstTcsRate: sgstRate,
      sgstTcsAmount: sgstAmount,
      utgstTcsRate: utgstRate,
      utgstTcsAmount: utgstAmount,
      igstTcsRate: igstRate,
      igstTcsAmount: igstAmount,
      totalTcsAmount,
      effectiveNotification: schedule.notificationReference
    };
  }
}
