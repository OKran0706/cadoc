import * as turf from "@turf/turf";
import type { FeatureCollection, Geometry, Feature } from "geojson";

let cachedCountriesGeoJson: FeatureCollection | null = null;

/**
 * Load local countries GeoJSON (50m resolution, 241 countries)
 */
export async function getCountriesGeoJson(): Promise<FeatureCollection> {
  if (cachedCountriesGeoJson) return cachedCountriesGeoJson;
  try {
    const res = await fetch("/geo/countries-50m.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as FeatureCollection;
    cachedCountriesGeoJson = data;
    return data;
  } catch (err) {
    console.warn("Could not load /geo/countries-50m.json:", err);
    return { type: "FeatureCollection", features: [] };
  }
}

/**
 * Resolve country name and approximate country code from coordinates using point-in-polygon
 */
export async function resolveCountryFromCoords(
  lng: number,
  lat: number
): Promise<{ country: string; countryCode: string } | null> {
  const geojson = await getCountriesGeoJson();
  if (!geojson.features || geojson.features.length === 0) return null;

  const pt = turf.point([lng, lat]);
  for (const feature of geojson.features) {
    try {
      if (turf.booleanPointInPolygon(pt, feature as any)) {
        const name = (feature.properties as any)?.name || "Unknown Country";
        const code = COUNTRY_NAME_TO_CODE[name] || "UN";
        return { country: name, countryCode: code };
      }
    } catch {
      // ignore geometry edge-case parse errors
    }
  }
  return null;
}

/**
 * Name-to-ISO-2 lookup table for Natural Earth 50m names
 */
export const COUNTRY_NAME_TO_CODE: Record<string, string> = {
  "United States of America": "US",
  "United States": "US",
  Germany: "DE",
  India: "IN",
  "United Kingdom": "GB",
  Japan: "JP",
  Brazil: "BR",
  Russia: "RU",
  Romania: "RO",
  France: "FR",
  China: "CN",
  Australia: "AU",
  Canada: "CA",
  Netherlands: "NL",
  Singapore: "SG",
  Switzerland: "CH",
  Israel: "IL",
  Ukraine: "UA",
  Sweden: "SE",
  Ireland: "IE",
};

/**
 * Generate a great-circle arc GeoJSON LineString between two [lng, lat] coordinates
 */
export function createGreatCircleArc(
  startLngLat: [number, number],
  endLngLat: [number, number],
  numPoints: number = 40
): number[][] {
  try {
    const arcFeature = turf.greatCircle(startLngLat, endLngLat, { npoints: numPoints });
    if (arcFeature && arcFeature.geometry && arcFeature.geometry.type === "LineString") {
      return arcFeature.geometry.coordinates;
    }
  } catch (err) {
    console.warn("Great circle generation error, falling back to straight line:", err);
  }
  return [startLngLat, endLngLat];
}

/**
 * Format local time for an IANA timezone string
 */
export function formatLocalTime(timezone: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(new Date());
  } catch {
    return new Date().toLocaleTimeString();
  }
}
