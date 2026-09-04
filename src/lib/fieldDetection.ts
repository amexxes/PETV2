import type { DetectedField, FieldKey, SheetAnalysis, SheetRole } from "./types";
import { normalizeText, parseNumber, similarity } from "./text";

const ALIASES: Record<FieldKey, string[]> = {
  entityId: [
    "entity id",
    "company id",
    "legal entity id",
    "entity code",
    "company code",
    "business unit",
    "business unit code",
    "business unit id",
    "bu",
    "id entiteit",
  ],
  entityName: ["entity", "entity name", "company", "company name", "legal entity", "subsidiary", "entiteit", "vennootschap", "gesellschaft", "societe"],
  parentEntity: ["parent", "parent entity", "parent company", "holding company", "direct parent", "shareholder", "moedermaatschappij", "muttergesellschaft"],
  ownershipPct: ["ownership", "ownership %", "ownership percentage", "shareholding", "shareholding %", "equity interest", "interest %", "participation %", "belang", "aandelenbelang"],
  country: ["country", "jurisdiction", "country code", "land", "staat", "pays"],
  currency: ["currency", "currency code", "base currency", "reporting currency", "functional currency", "ccy", "valuta", "waehrung", "devise"],
  period: ["period", "reporting period", "quarter", "as of", "date", "year", "periode", "rapportageperiode"],
  glAccount: ["gl account", "gl account number", "account", "account number", "account no", "ledger account", "general ledger account", "rekening", "grootboekrekening", "konto"],
  glDescription: ["gl description", "account description", "description", "account name", "ledger description", "omschrijving", "rekeningomschrijving", "kontobezeichnung"],
  balance: [
    "closing balance",
    "ending balance",
    "end balance",
    "balance",
    "period end balance",
    "ytd balance",
    "amount",
    "sum amount",
    "base amount",
    "reporting amount",
    "functional amount",
    "eur amount",
    "balance eur",
    "closing eur",
    "saldo",
    "eindsaldo",
  ],
  accountCategory: [
    "account category",
    "account type",
    "category",
    "financial statement line",
    "fs category",
    "account grouping",
    "subgrouping",
    "subgrouping 2",
    "sub grouping 2",
    "rekeningcategorie",
    "kontokategorie",
  ],
  balanceSheetSide: [
    "balance sheet side",
    "bs side",
    "asset liability",
    "assets liabilities",
    "statement side",
    "statement type",
    "financial statement",
    "grouping",
    "debit credit",
    "dr cr",
    "zijde",
    "bilanzseite",
  ],
  fairValue: ["fair value", "market value", "tax value", "adjusted value", "fmv", "reele waarde", "marktwaarde"],
  bookValue: ["book value", "carrying value", "tb value", "boekwaarde"],
  taxRate: ["tax rate", "corporate tax rate", "cit rate", "effective tax rate", "etr", "belastingtarief"],
  motiveTest: ["motive test", "motive", "investment motive", "oogmerktoets", "beleggingsoogmerk"],
  subjectToTaxTest: ["subject to tax", "subject to tax test", "taxation test", "onderworpenheidstoets"],
};

const ROLE_HINTS: Record<Exclude<SheetRole, "error">, string[]> = {
  structure: ["structure", "group structure", "ownership", "legal structure", "entities", "org chart", "deelnemingen"],
  trial_balance: ["trial balance", "tb", "ledger", "gl", "balance", "saldo", "saldi"],
  fair_value: ["fair value", "valuation", "adjustment", "fmv", "marktwaarde"],
  tax_master: ["tax master", "tax data", "tax rate", "subject to tax", "motive", "tax facts"],
  other: [],
};

function aliasScore(value: unknown, field: FieldKey): number {
  return Math.max(...ALIASES[field].map((alias) => similarity(value, alias)), 0);
}

function dataInferenceScore(field: FieldKey, values: unknown[]): number {
  const sample = values.filter((value) => String(value ?? "").trim() !== "").slice(0, 40);
  if (sample.length < 2) return 0;

  const numeric = sample.map(parseNumber).filter((value): value is number => value !== null);
  const numericRatio = numeric.length / sample.length;
  const strings = sample.map((value) => String(value ?? "").trim());

  if (field === "ownershipPct" && numericRatio > 0.6) {
    const plausible = numeric.filter((number) => Math.abs(number) <= 100).length / numeric.length;
    return plausible * 0.58;
  }
  if (field === "balance" && numericRatio > 0.75) return 0.5;
  if (field === "period") {
    const plausible = strings.filter((value) => /^(19|20)\d{2}$/.test(value) || /q[1-4]/i.test(value) || !Number.isNaN(Date.parse(value))).length / sample.length;
    return plausible * 0.35;
  }
  if (field === "currency") {
    const plausible = strings.filter((value) => /^[A-Za-z]{3}$/.test(value)).length / sample.length;
    return plausible * 0.72;
  }
  if (field === "country") {
    const plausible = strings.filter((value) => /^[A-Za-z]{2,3}$/.test(value) || /^[A-Za-z .'-]{4,30}$/.test(value)).length / sample.length;
    return plausible * 0.28;
  }
  if (field === "glAccount") {
    const plausible = strings.filter((value) => /^[A-Za-z0-9._/-]{2,20}$/.test(value)).length / sample.length;
    const unique = new Set(strings).size / sample.length;
    return plausible * Math.max(0.35, unique) * 0.4;
  }
  if (field === "entityId") {
    const plausible = strings.filter((value) => /^[A-Za-z0-9._/-]{2,24}$/.test(value)).length / sample.length;
    const dominant = Math.max(...[...new Set(strings)].map((value) => strings.filter((candidate) => candidate === value).length), 0) / sample.length;
    return plausible * Math.max(0.35, dominant) * 0.36;
  }
  if (["entityName", "parentEntity", "glDescription", "accountCategory", "balanceSheetSide"].includes(field)) {
    const textRatio = strings.filter((value) => /[A-Za-z]/.test(value)).length / sample.length;
    return textRatio * 0.22;
  }
  if (field === "taxRate" && numericRatio > 0.6) {
    const plausible = numeric.filter((number) => Math.abs(number) <= 100).length / numeric.length;
    return plausible * 0.5;
  }
  return 0;
}

function detectFieldsForHeader(rows: unknown[][], headerIndex: number): DetectedField[] {
  const header = rows[headerIndex] ?? [];
  const candidates: Array<DetectedField & { score: number }> = [];

  for (let columnIndex = 0; columnIndex < header.length; columnIndex += 1) {
    const headerValue = header[columnIndex];
    if (!String(headerValue ?? "").trim()) continue;
    const below = rows.slice(headerIndex + 1, headerIndex + 41).map((row) => row[columnIndex]);
    for (const field of Object.keys(ALIASES) as FieldKey[]) {
      const lexical = aliasScore(headerValue, field);
      const inferred = dataInferenceScore(field, below);
      const score = Math.min(1, lexical * 0.84 + inferred * 0.16);
      if (score >= 0.5) candidates.push({ field, columnIndex, header: String(headerValue), confidence: score, score });
    }
  }

  candidates.sort((first, second) => second.score - first.score);
  const usedFields = new Set<FieldKey>();
  const usedColumns = new Set<number>();
  const fields: DetectedField[] = [];

  for (const candidate of candidates) {
    if (usedFields.has(candidate.field) || usedColumns.has(candidate.columnIndex) || candidate.confidence < 0.63) continue;
    usedFields.add(candidate.field);
    usedColumns.add(candidate.columnIndex);
    fields.push({ field: candidate.field, columnIndex: candidate.columnIndex, header: candidate.header, confidence: candidate.confidence });
  }
  return fields;
}

function roleForFields(sheetName: string, fields: DetectedField[]): SheetRole {
  const names = new Set(fields.map((field) => field.field));
  const sheetNorm = normalizeText(sheetName);
  const roleHint = (role: keyof typeof ROLE_HINTS) => ROLE_HINTS[role].some((hint) => sheetNorm.includes(normalizeText(hint)));
  const hasEntity = names.has("entityName") || names.has("entityId");

  if (hasEntity && names.has("parentEntity") && names.has("ownershipPct")) return "structure";
  if (roleHint("structure") && hasEntity && names.has("ownershipPct")) return "structure";
  if (names.has("glAccount") && names.has("balance")) return "trial_balance";
  if (roleHint("trial_balance") && names.has("glAccount") && names.has("balance")) return "trial_balance";
  if (names.has("fairValue") && (names.has("glAccount") || hasEntity)) return "fair_value";
  if (roleHint("fair_value") && names.has("fairValue")) return "fair_value";
  if ((names.has("taxRate") || names.has("motiveTest") || names.has("subjectToTaxTest")) && hasEntity) return "tax_master";
  if (roleHint("tax_master") && (names.has("taxRate") || names.has("motiveTest") || names.has("subjectToTaxTest"))) return "tax_master";
  return "other";
}

function headerCandidateScore(role: SheetRole, fields: DetectedField[]): number {
  if (role === "other") return 0;
  const strong = fields.filter((field) => field.confidence >= 0.74).length;
  const total = fields.reduce((sum, field) => sum + field.confidence, 0);
  const roleBonus = role === "trial_balance" || role === "structure" ? 4 : 2;
  return roleBonus + strong * 2 + total;
}

export function analyseSheet(sheetName: string, rows: unknown[][]): SheetAnalysis {
  const nonEmptyRows = rows.filter((row) => row.some((value) => String(value ?? "").trim() !== ""));
  const columnCount = Math.max(0, ...rows.map((row) => row.length));
  const scanLimit = Math.min(rows.length, 40);

  let bestIndex: number | null = null;
  let bestFields: DetectedField[] = [];
  let bestRole: SheetRole = "other";
  let bestScore = 0;

  for (let rowIndex = 0; rowIndex < scanLimit; rowIndex += 1) {
    const fields = detectFieldsForHeader(rows, rowIndex);
    const role = roleForFields(sheetName, fields);
    const score = headerCandidateScore(role, fields);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = rowIndex;
      bestFields = fields;
      bestRole = role;
    }
  }

  if (bestRole === "other" || bestIndex === null) {
    return {
      sheetName,
      rowCount: nonEmptyRows.length,
      columnCount,
      headerRow: null,
      role: "other",
      confidence: 0,
      fields: [],
      errors: [],
      warnings: [],
    };
  }

  const names = new Set(bestFields.map((field) => field.field));
  const errors: string[] = [];
  const warnings: string[] = [];

  if (bestRole === "structure") {
    if (!names.has("entityName") && !names.has("entityId")) errors.push("Entity/company column not detected.");
    if (!names.has("parentEntity")) warnings.push("Parent column not detected; entities may be treated as roots.");
    if (!names.has("ownershipPct")) errors.push("Ownership percentage column not detected.");
  }
  if (bestRole === "trial_balance") {
    if (!names.has("glAccount")) errors.push("GL account column not detected.");
    if (!names.has("balance")) errors.push("Balance column not detected.");
    if (!names.has("glDescription")) warnings.push("GL description column not detected; classification confidence will be lower.");
    if (!names.has("entityName") && !names.has("entityId")) warnings.push("No entity column detected; the entity will be inferred from the sheet or workbook context when possible.");
  }

  const confidence = bestFields.length ? bestFields.reduce((sum, field) => sum + field.confidence, 0) / bestFields.length : 0;
  if (confidence < 0.68) warnings.push("Low recognition confidence. Review detected columns before relying on the calculation.");

  return {
    sheetName,
    rowCount: nonEmptyRows.length,
    columnCount,
    headerRow: bestIndex + 1,
    role: errors.length ? "error" : bestRole,
    confidence,
    fields: bestFields,
    errors,
    warnings,
  };
}

export function fieldMap(analysis: SheetAnalysis): Partial<Record<FieldKey, number>> {
  return Object.fromEntries(analysis.fields.map((field) => [field.field, field.columnIndex]));
}
