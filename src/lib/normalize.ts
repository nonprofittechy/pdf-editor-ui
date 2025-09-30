import type { PdfField } from "@/types/form";

const toSnakeCase = (str: string): string => {
  let s = str
    .replace(/[^a-zA-Z0-9\s\-_]/g, "") // Remove invalid characters
    .replace(/([A-Z])/g, "_$1") // Add underscore before uppercase letters
    .replace(/[\s\-]+/g, "_") // Replace spaces and hyphens with underscore
    .replace(/__+/g, "_") // Replace multiple underscores with single
    .replace(/^_|_$/g, "") // Remove leading/trailing underscores
    .toLowerCase();

  if (/^[0-9]/.test(s)) {
    s = `_${s}`;
  }

  return s;
};

const regexList: [RegExp, string][] = [
  // Personal info
  // Name & Bio
  [/^((My|Your|Full( legal)?) )?Name$/i, "users1_name"],
  [/^(Typed or )?Printed Name\s?\d*$/i, "users1_name"],
  [/^(DOB|Date of Birth|Birthday)$/i, "users1_birthdate"],
  // Address
  [/^(Street )?Address$/i, "users1_address_line_one"],
  [/^City State Zip$/i, "users1_address_line_two"],
  [/^City$/i, "users1_address_city"],
  [/^State$/i, "users1_address_state"],
  [/^Zip( Code)?$/i, "users1_address_zip"],
  // Contact
  [/^(Phone|Telephone)$/i, "users1_phone_number"],
  [/^Email( Address)?$/i, "users1_email"],
  // Parties
  [/^plaintiff\(?s?\)?$/i, "plaintiff1_name"],
  [/^defendant\(?s?\)?$/i, "defendant1_name"],
  [/^petitioner\(?s?\)?$/i, "petitioners1_name"],
  [/^respondent\(?s?\)?$/i, "respondents1_name"],
  // Court info
  [/^(Court\s)?Case\s?(No|Number)?\s?A?$/i, "docket_number"],
  [/^file\s?(No|Number)?\s?A?$/i, "docket_number"],
  // Form info
  [/^(Signature|Sign( here)?)\s?\d*$/i, "users1_signature"],
  [/^Date\s?\d*$/i, "signature_date"],
];

const applyRegex = (name: string): string | null => {
  for (const [regex, replacement] of regexList) {
    if (regex.test(name.trim())) {
      return replacement;
    }
  }
  return null;
};

const stopWords = ["a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for", "of"];

const normalizeName = (originalName: string): string => {
  const fromRegex = applyRegex(originalName);
  if (fromRegex) {
    return fromRegex;
  }

  let normalized = toSnakeCase(originalName);

  const words = normalized.split("_");
  const filteredWords = words.filter((word) => !stopWords.includes(word));
  normalized = filteredWords.join("_");

  // Simple shortening
  if (normalized.length > 30) {
    normalized = normalized.substring(0, 30);
  }
  return normalized;
};

export const normalizeFieldNames = (fields: PdfField[]): PdfField[] => {
  const normalizedFields = fields.map((field) => ({
    ...field,
    name: normalizeName(field.name),
  }));

  const nameGroups = new Map<string, PdfField[]>();
  for (const field of normalizedFields) {
    if (!nameGroups.has(field.name)) {
      nameGroups.set(field.name, []);
    }
    nameGroups.get(field.name)!.push(field);
  }

  for (const group of nameGroups.values()) {
    if (group.length > 1) {
      group.forEach((field, index) => {
        field.name = `${field.name}__${index + 1}`;
      });
    }
  }

  return normalizedFields;
};