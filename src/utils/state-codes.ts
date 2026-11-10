export enum JurisdictionCategory {
  STATE = 'STATE',                                                    // SGST applies
  UNION_TERRITORY_WITH_LEGISLATURE = 'UNION_TERRITORY_WITH_LEGISLATURE', // SGST applies (Delhi, Puducherry, J&K)
  UNION_TERRITORY_WITHOUT_LEGISLATURE = 'UNION_TERRITORY_WITHOUT_LEGISLATURE', // UTGST applies (Chandigarh, D&NH & D&D, Lakshadweep, A&N, Ladakh)
  OTHER_TERRITORY = 'OTHER_TERRITORY'                                  // Section 2(81) CGST Act / Section 7(5)(a) IGST Act (offshore / continental shelf)
}

export interface StateJurisdiction {
  code: string;
  name: string;
  category: JurisdictionCategory;
}

export const INDIAN_STATE_CODES: Record<string, StateJurisdiction> = {
  '01': { code: '01', name: 'Jammu and Kashmir', category: JurisdictionCategory.UNION_TERRITORY_WITH_LEGISLATURE },
  '02': { code: '02', name: 'Himachal Pradesh', category: JurisdictionCategory.STATE },
  '03': { code: '03', name: 'Punjab', category: JurisdictionCategory.STATE },
  '04': { code: '04', name: 'Chandigarh', category: JurisdictionCategory.UNION_TERRITORY_WITHOUT_LEGISLATURE },
  '05': { code: '05', name: 'Uttarakhand', category: JurisdictionCategory.STATE },
  '06': { code: '06', name: 'Haryana', category: JurisdictionCategory.STATE },
  '07': { code: '07', name: 'Delhi', category: JurisdictionCategory.UNION_TERRITORY_WITH_LEGISLATURE },
  '08': { code: '08', name: 'Rajasthan', category: JurisdictionCategory.STATE },
  '09': { code: '09', name: 'Uttar Pradesh', category: JurisdictionCategory.STATE },
  '10': { code: '10', name: 'Bihar', category: JurisdictionCategory.STATE },
  '11': { code: '11', name: 'Sikkim', category: JurisdictionCategory.STATE },
  '12': { code: '12', name: 'Arunachal Pradesh', category: JurisdictionCategory.STATE },
  '13': { code: '13', name: 'Nagaland', category: JurisdictionCategory.STATE },
  '14': { code: '14', name: 'Manipur', category: JurisdictionCategory.STATE },
  '15': { code: '15', name: 'Mizoram', category: JurisdictionCategory.STATE },
  '16': { code: '16', name: 'Tripura', category: JurisdictionCategory.STATE },
  '17': { code: '17', name: 'Meghalaya', category: JurisdictionCategory.STATE },
  '18': { code: '18', name: 'Assam', category: JurisdictionCategory.STATE },
  '19': { code: '19', name: 'West Bengal', category: JurisdictionCategory.STATE },
  '20': { code: '20', name: 'Jharkhand', category: JurisdictionCategory.STATE },
  '21': { code: '21', name: 'Odisha', category: JurisdictionCategory.STATE },
  '22': { code: '22', name: 'Chhattisgarh', category: JurisdictionCategory.STATE },
  '23': { code: '23', name: 'Madhya Pradesh', category: JurisdictionCategory.STATE },
  '24': { code: '24', name: 'Gujarat', category: JurisdictionCategory.STATE },
  '26': { code: '26', name: 'Dadra and Nagar Haveli and Daman and Diu', category: JurisdictionCategory.UNION_TERRITORY_WITHOUT_LEGISLATURE },
  '27': { code: '27', name: 'Maharashtra', category: JurisdictionCategory.STATE },
  '28': { code: '28', name: 'Andhra Pradesh (Old)', category: JurisdictionCategory.STATE },
  '29': { code: '29', name: 'Karnataka', category: JurisdictionCategory.STATE },
  '30': { code: '30', name: 'Goa', category: JurisdictionCategory.STATE },
  '31': { code: '31', name: 'Lakshadweep', category: JurisdictionCategory.UNION_TERRITORY_WITHOUT_LEGISLATURE },
  '32': { code: '32', name: 'Kerala', category: JurisdictionCategory.STATE },
  '33': { code: '33', name: 'Tamil Nadu', category: JurisdictionCategory.STATE },
  '34': { code: '34', name: 'Puducherry', category: JurisdictionCategory.UNION_TERRITORY_WITH_LEGISLATURE },
  '35': { code: '35', name: 'Andaman and Nicobar Islands', category: JurisdictionCategory.UNION_TERRITORY_WITHOUT_LEGISLATURE },
  '36': { code: '36', name: 'Telangana', category: JurisdictionCategory.STATE },
  '37': { code: '37', name: 'Andhra Pradesh', category: JurisdictionCategory.STATE },
  '38': { code: '38', name: 'Ladakh', category: JurisdictionCategory.UNION_TERRITORY_WITHOUT_LEGISLATURE },
  '97': { code: '97', name: 'Other Territory', category: JurisdictionCategory.OTHER_TERRITORY }
};

export function getJurisdiction(code: string | null | undefined): StateJurisdiction | null {
  if (!code) return null;
  return INDIAN_STATE_CODES[code.trim()] || null;
}

export function isValidStateCode(code: string | null | undefined): boolean {
  return getJurisdiction(code) !== null;
}

export function getJurisdictionCategory(code: string | null | undefined): JurisdictionCategory | null {
  const jurisdiction = getJurisdiction(code);
  return jurisdiction ? jurisdiction.category : null;
}

/**
 * UTGST strictly applies to intra-Union territory supplies in Union Territories without legislature
 * under Section 7(1) of the UTGST Act, 2017.
 * Other Territory (code 97) is governed by Section 7(5)(a) of the IGST Act (interstate treatment)
 * and is not classified as an intra-UT UTGST jurisdiction.
 */
export function isUTGSTApplicable(stateCode: string): boolean {
  const category = getJurisdictionCategory(stateCode);
  return category === JurisdictionCategory.UNION_TERRITORY_WITHOUT_LEGISLATURE;
}

export function isValidGSTINStructure(gstin: string | null | undefined): boolean {
  if (!gstin) return false;
  const trimmed = gstin.trim().toUpperCase();
  if (trimmed.length !== 15) return false;
  const stateCode = trimmed.slice(0, 2);
  if (!isValidStateCode(stateCode)) return false;
  const regex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
  return regex.test(trimmed);
}

export function extractPANFromGSTIN(gstin: string): string | null {
  const trimmed = gstin.trim().toUpperCase();
  if (trimmed.length === 15) {
    return trimmed.slice(2, 12);
  }
  return null;
}
