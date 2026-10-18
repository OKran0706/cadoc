export interface Country {
  code: string;
  name: string;
  flag: string;
  region: "Americas" | "Europe" | "Asia Pacific" | "Middle East & Africa";
}

export const COUNTRIES: Country[] = [
  // ─── Major Cloud & Datacenter Hubs ───
  { code: "US", name: "United States", flag: "🇺🇸", region: "Americas" },
  { code: "GB", name: "United Kingdom", flag: "🇬🇧", region: "Europe" },
  { code: "DE", name: "Germany", flag: "🇩🇪", region: "Europe" },
  { code: "JP", name: "Japan", flag: "🇯🇵", region: "Asia Pacific" },
  { code: "SG", name: "Singapore", flag: "🇸🇬", region: "Asia Pacific" },
  { code: "IN", name: "India", flag: "🇮🇳", region: "Asia Pacific" },
  { code: "CA", name: "Canada", flag: "🇨🇦", region: "Americas" },
  { code: "AU", name: "Australia", flag: "🇦🇺", region: "Asia Pacific" },
  { code: "FR", name: "France", flag: "🇫🇷", region: "Europe" },
  { code: "NL", name: "Netherlands", flag: "🇳🇱", region: "Europe" },
  { code: "IE", name: "Ireland", flag: "🇮🇪", region: "Europe" },
  { code: "BR", name: "Brazil", flag: "🇧🇷", region: "Americas" },
  { code: "KR", name: "South Korea", flag: "🇰🇷", region: "Asia Pacific" },
  { code: "SE", name: "Sweden", flag: "🇸🇪", region: "Europe" },
  { code: "CH", name: "Switzerland", flag: "🇨🇭", region: "Europe" },
  { code: "IL", name: "Israel", flag: "🇮🇱", region: "Middle East & Africa" },
  { code: "AE", name: "United Arab Emirates", flag: "🇦🇪", region: "Middle East & Africa" },
  { code: "ZA", name: "South Africa", flag: "🇿🇦", region: "Middle East & Africa" },

  // ─── Americas ───
  { code: "AR", name: "Argentina", flag: "🇦🇷", region: "Americas" },
  { code: "CL", name: "Chile", flag: "🇨🇱", region: "Americas" },
  { code: "CO", name: "Colombia", flag: "🇨🇴", region: "Americas" },
  { code: "MX", name: "Mexico", flag: "🇲🇽", region: "Americas" },
  { code: "PE", name: "Peru", flag: "🇵🇪", region: "Americas" },
  { code: "CR", name: "Costa Rica", flag: "🇨🇷", region: "Americas" },
  { code: "PA", name: "Panama", flag: "🇵🇦", region: "Americas" },

  // ─── Europe ───
  { code: "AT", name: "Austria", flag: "🇦🇹", region: "Europe" },
  { code: "BE", name: "Belgium", flag: "🇧🇪", region: "Europe" },
  { code: "BG", name: "Bulgaria", flag: "🇧🇬", region: "Europe" },
  { code: "HR", name: "Croatia", flag: "🇭🇷", region: "Europe" },
  { code: "CY", name: "Cyprus", flag: "🇨🇾", region: "Europe" },
  { code: "CZ", name: "Czech Republic", flag: "🇨🇿", region: "Europe" },
  { code: "DK", name: "Denmark", flag: "🇩🇰", region: "Europe" },
  { code: "EE", name: "Estonia", flag: "🇪🇪", region: "Europe" },
  { code: "FI", name: "Finland", flag: "🇫🇮", region: "Europe" },
  { code: "GR", name: "Greece", flag: "🇬🇷", region: "Europe" },
  { code: "HU", name: "Hungary", flag: "🇭🇺", region: "Europe" },
  { code: "IS", name: "Iceland", flag: "🇮🇸", region: "Europe" },
  { code: "IT", name: "Italy", flag: "🇮🇹", region: "Europe" },
  { code: "LV", name: "Latvia", flag: "🇱🇻", region: "Europe" },
  { code: "LT", name: "Lithuania", flag: "🇱🇹", region: "Europe" },
  { code: "LU", name: "Luxembourg", flag: "🇱🇺", region: "Europe" },
  { code: "NO", name: "Norway", flag: "🇳🇴", region: "Europe" },
  { code: "PL", name: "Poland", flag: "🇵🇱", region: "Europe" },
  { code: "PT", name: "Portugal", flag: "🇵🇹", region: "Europe" },
  { code: "RO", name: "Romania", flag: "🇷🇴", region: "Europe" },
  { code: "SK", name: "Slovakia", flag: "🇸🇰", region: "Europe" },
  { code: "ES", name: "Spain", flag: "🇪🇸", region: "Europe" },
  { code: "UA", name: "Ukraine", flag: "🇺🇦", region: "Europe" },

  // ─── Asia Pacific ───
  { code: "HK", name: "Hong Kong", flag: "🇭🇰", region: "Asia Pacific" },
  { code: "ID", name: "Indonesia", flag: "🇮🇩", region: "Asia Pacific" },
  { code: "MY", name: "Malaysia", flag: "🇲🇾", region: "Asia Pacific" },
  { code: "NZ", name: "New Zealand", flag: "🇳🇿", region: "Asia Pacific" },
  { code: "PH", name: "Philippines", flag: "🇵🇭", region: "Asia Pacific" },
  { code: "TW", name: "Taiwan", flag: "🇹🇼", region: "Asia Pacific" },
  { code: "TH", name: "Thailand", flag: "🇹🇭", region: "Asia Pacific" },
  { code: "VN", name: "Vietnam", flag: "🇻🇳", region: "Asia Pacific" },

  // ─── Middle East & Africa ───
  { code: "EG", name: "Egypt", flag: "🇪🇬", region: "Middle East & Africa" },
  { code: "KE", name: "Kenya", flag: "🇰🇪", region: "Middle East & Africa" },
  { code: "MA", name: "Morocco", flag: "🇲🇦", region: "Middle East & Africa" },
  { code: "NG", name: "Nigeria", flag: "🇳🇬", region: "Middle East & Africa" },
  { code: "QA", name: "Qatar", flag: "🇶🇦", region: "Middle East & Africa" },
  { code: "SA", name: "Saudi Arabia", flag: "🇸🇦", region: "Middle East & Africa" },
  { code: "TR", name: "Turkey", flag: "🇹🇷", region: "Middle East & Africa" },
];

/** Quick lookup map by uppercase ISO 3166-1 alpha-2 code */
const COUNTRY_MAP = new Map<string, Country>(
  COUNTRIES.map((c) => [c.code.toUpperCase(), c])
);

/**
 * Find country by 2-letter ISO code
 */
export function getCountryByCode(code?: string | null): Country | undefined {
  if (!code) return undefined;
  return COUNTRY_MAP.get(code.trim().toUpperCase());
}

/**
 * Format structured location string from country and optional city/datacenter region
 */
export function formatLocation(countryCode: string, cityOrRegion?: string): string {
  const country = getCountryByCode(countryCode);
  const countryLabel = country ? `${country.name} (${country.code})` : countryCode;
  if (!cityOrRegion || !cityOrRegion.trim()) {
    return countryLabel;
  }
  return `${cityOrRegion.trim()}, ${countryLabel}`;
}
