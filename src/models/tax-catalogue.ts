import { Decimal, toDecimal } from '../utils/decimal.js';

export interface TaxRateEntry {
  rateId: string;
  name: string;
  standardRate: Decimal;        // Total combined rate (%)
  cgstRate: Decimal;            // Half of standard rate for intrastate
  sgstRate: Decimal;            // Half of standard rate for intrastate in States
  utgstRate: Decimal;           // Half of standard rate for intrastate in UTs without legislature
  igstRate: Decimal;            // Equal to standard rate for interstate
  cessRate?: Decimal;           // Ad valorem cess (%)
  effectiveFrom: string;        // YYYY-MM-DD
  effectiveTo?: string;         // YYYY-MM-DD (undefined if currently active)
  notificationReference: string;// Statutory notification reference
  applicableCategories?: string[];
}

export class TaxRateCatalogue {
  private rates: TaxRateEntry[] = [];

  constructor(initialRates?: TaxRateEntry[]) {
    if (initialRates && initialRates.length > 0) {
      this.rates = [...initialRates];
    } else {
      this.loadStandardSchedules();
    }
  }

  private loadStandardSchedules(): void {
    const baseEffectiveDate = '2017-07-01';

    // 0% - Nil / Exempt (Notification No. 02/2017-Central Tax (Rate))
    this.addRate({
      rateId: 'GST-0',
      name: 'Nil Rated / Exempt',
      standardRate: new Decimal(0),
      cgstRate: new Decimal(0),
      sgstRate: new Decimal(0),
      utgstRate: new Decimal(0),
      igstRate: new Decimal(0),
      effectiveFrom: baseEffectiveDate,
      notificationReference: 'Notification No. 02/2017-Central Tax (Rate)'
    });

    // 0.25% - Rough Diamonds and Precious Stones (Schedule V, Notif. 01/2017-CT(Rate))
    this.addRate({
      rateId: 'GST-0.25',
      name: 'Rough Diamonds and Precious Stones',
      standardRate: new Decimal(0.25),
      cgstRate: new Decimal(0.125),
      sgstRate: new Decimal(0.125),
      utgstRate: new Decimal(0.125),
      igstRate: new Decimal(0.25),
      effectiveFrom: baseEffectiveDate,
      notificationReference: 'Schedule V, Notification No. 01/2017-Central Tax (Rate)'
    });

    // 1% - Affordable Residential Housing without ITC (Notification No. 03/2019-Central Tax (Rate))
    this.addRate({
      rateId: 'GST-1',
      name: 'Affordable Residential Housing (without ITC)',
      standardRate: new Decimal(1),
      cgstRate: new Decimal(0.5),
      sgstRate: new Decimal(0.5),
      utgstRate: new Decimal(0.5),
      igstRate: new Decimal(1),
      effectiveFrom: '2019-04-01',
      notificationReference: 'Notification No. 03/2019-Central Tax (Rate)'
    });

    // 3% - Gold, Silver, Jewellery (Schedule VI, Notif. 01/2017-CT(Rate))
    this.addRate({
      rateId: 'GST-3',
      name: 'Gold, Silver and Precious Metal Articles',
      standardRate: new Decimal(3),
      cgstRate: new Decimal(1.5),
      sgstRate: new Decimal(1.5),
      utgstRate: new Decimal(1.5),
      igstRate: new Decimal(3),
      effectiveFrom: baseEffectiveDate,
      notificationReference: 'Schedule VI, Notification No. 01/2017-Central Tax (Rate)'
    });

    // 5% - Standard Slab 1 (Schedule I, Notif. 01/2017-CT(Rate))
    this.addRate({
      rateId: 'GST-5',
      name: 'Standard Slab 5%',
      standardRate: new Decimal(5),
      cgstRate: new Decimal(2.5),
      sgstRate: new Decimal(2.5),
      utgstRate: new Decimal(2.5),
      igstRate: new Decimal(5),
      effectiveFrom: baseEffectiveDate,
      notificationReference: 'Schedule I, Notification No. 01/2017-Central Tax (Rate)'
    });

    // 12% - Standard Slab 2 (Schedule II, Notif. 01/2017-CT(Rate))
    this.addRate({
      rateId: 'GST-12',
      name: 'Standard Slab 12%',
      standardRate: new Decimal(12),
      cgstRate: new Decimal(6),
      sgstRate: new Decimal(6),
      utgstRate: new Decimal(6),
      igstRate: new Decimal(12),
      effectiveFrom: baseEffectiveDate,
      notificationReference: 'Schedule II, Notification No. 01/2017-Central Tax (Rate)'
    });

    // 18% - Standard Slab 3 (Schedule III, Notif. 01/2017-CT(Rate))
    this.addRate({
      rateId: 'GST-18',
      name: 'Standard Slab 18%',
      standardRate: new Decimal(18),
      cgstRate: new Decimal(9),
      sgstRate: new Decimal(9),
      utgstRate: new Decimal(9),
      igstRate: new Decimal(18),
      effectiveFrom: baseEffectiveDate,
      notificationReference: 'Schedule III, Notification No. 01/2017-Central Tax (Rate)'
    });

    // 28% - Standard Slab 4 (Schedule IV, Notif. 01/2017-CT(Rate))
    this.addRate({
      rateId: 'GST-28',
      name: 'Standard Slab 28%',
      standardRate: new Decimal(28),
      cgstRate: new Decimal(14),
      sgstRate: new Decimal(14),
      utgstRate: new Decimal(14),
      igstRate: new Decimal(28),
      effectiveFrom: baseEffectiveDate,
      notificationReference: 'Schedule IV, Notification No. 01/2017-Central Tax (Rate)'
    });
  }

  public addRate(rate: TaxRateEntry): void {
    this.rates.push(rate);
  }

  /**
   * Find matching rate entry for a given rate value and transaction date.
   */
  public findRate(rateVal: Decimal | number | string, dateStr?: string): TaxRateEntry | null {
    const decRate = toDecimal(rateVal);
    const targetDate = dateStr || new Date().toISOString().slice(0, 10);

    for (const r of this.rates) {
      if (r.standardRate.equals(decRate)) {
        if (r.effectiveFrom <= targetDate && (!r.effectiveTo || r.effectiveTo >= targetDate)) {
          return r;
        }
      }
    }
    return null;
  }

  /**
   * Validates if the given rate is in the active GST rate catalog for the given transaction date.
   */
  public isRateValid(rateVal: Decimal | number | string, dateStr?: string): boolean {
    return this.findRate(rateVal, dateStr) !== null;
  }

  public getAllRates(): readonly TaxRateEntry[] {
    return this.rates;
  }
}

export const defaultTaxRateCatalogue = new TaxRateCatalogue();
