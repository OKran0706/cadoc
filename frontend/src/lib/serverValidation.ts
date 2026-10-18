import { getCountryByCode } from "@/lib/countries";

export interface ValidationResult {
  isValid: boolean;
  error?: string;
}

export interface ServerFormState {
  name: string;
  country: string;
  cityOrRegion?: string;
  ip: string;
  profile: string;
  projectId?: string;
  newProjectName?: string;
}

export interface ServerFormErrors {
  name?: string;
  country?: string;
  ip?: string;
  project?: string;
  hasErrors: boolean;
}

/**
 * Strict Hostname Validator (RFC 1123 / Sentinel Node ID)
 * - 2 to 63 characters
 * - Alphanumeric characters, hyphens, underscores, dots
 * - Must begin and end with alphanumeric character
 */
export function validateHostname(name: string): ValidationResult {
  const trimmed = (name || "").trim();
  if (!trimmed) {
    return { isValid: false, error: "Server ID (hostname) is required." };
  }

  if (trimmed.length < 2) {
    return { isValid: false, error: "Server ID must be at least 2 characters long." };
  }

  if (trimmed.length > 63) {
    return { isValid: false, error: "Server ID cannot exceed 63 characters." };
  }

  // Reject spaces or invalid characters
  if (/\s/.test(trimmed)) {
    return { isValid: false, error: "Server ID cannot contain spaces." };
  }

  const hostnameRegex = /^[a-zA-Z0-9]([a-zA-Z0-9_.-]*[a-zA-Z0-9])?$/;
  if (!hostnameRegex.test(trimmed)) {
    return {
      isValid: false,
      error: "Server ID can only contain letters, numbers, hyphens, underscores, or dots (e.g. SENTINEL-NODE-05).",
    };
  }

  return { isValid: true };
}

/**
 * Strict IPv4 / IPv6 Address Validator
 */
export function validateIpAddress(ip: string): ValidationResult {
  const trimmed = (ip || "").trim();
  if (!trimmed) {
    return { isValid: false, error: "IP address is required." };
  }

  // IPv4: 4 octets 0-255 without leading zeroes
  const ipv4Regex =
    /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}$/;
  if (ipv4Regex.test(trimmed)) {
    return { isValid: true };
  }

  // IPv6: standard formats including compressed (::)
  const ipv6Regex =
    /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
  if (ipv6Regex.test(trimmed)) {
    return { isValid: true };
  }

  return {
    isValid: false,
    error: "Enter a valid IPv4 (e.g. 10.20.1.45) or IPv6 address.",
  };
}

/**
 * Country Selection Validator
 */
export function validateCountry(countryCode: string): ValidationResult {
  const trimmed = (countryCode || "").trim();
  if (!trimmed) {
    return { isValid: false, error: "Country selection is required." };
  }

  const country = getCountryByCode(trimmed);
  if (!country) {
    return { isValid: false, error: "Please select a valid country from the catalog." };
  }

  return { isValid: true };
}

/**
 * Project Validator
 */
export function validateProject(
  projectId: string | undefined,
  newProjectName: string | undefined,
  hasExistingProjects: boolean
): ValidationResult {
  if (hasExistingProjects) {
    if (!projectId || !projectId.trim()) {
      return { isValid: false, error: "Target project selection is required." };
    }
    return { isValid: true };
  }

  const trimmed = (newProjectName || "").trim();
  if (!trimmed) {
    return { isValid: false, error: "Project name is required." };
  }
  if (trimmed.length < 2) {
    return { isValid: false, error: "Project name must be at least 2 characters." };
  }
  return { isValid: true };
}

/**
 * Validate all Step 1 inputs
 */
export function validateServerForm(
  fields: ServerFormState,
  hasExistingProjects: boolean
): ServerFormErrors {
  const errors: ServerFormErrors = {
    hasErrors: false,
  };

  const nameVal = validateHostname(fields.name);
  if (!nameVal.isValid) {
    errors.name = nameVal.error;
    errors.hasErrors = true;
  }

  const countryVal = validateCountry(fields.country);
  if (!countryVal.isValid) {
    errors.country = countryVal.error;
    errors.hasErrors = true;
  }

  const ipVal = validateIpAddress(fields.ip);
  if (!ipVal.isValid) {
    errors.ip = ipVal.error;
    errors.hasErrors = true;
  }

  const projVal = validateProject(fields.projectId, fields.newProjectName, hasExistingProjects);
  if (!projVal.isValid) {
    errors.project = projVal.error;
    errors.hasErrors = true;
  }

  return errors;
}
