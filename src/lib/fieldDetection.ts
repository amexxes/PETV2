import { extractCurrencyCode } from "./currency";
import type { DetectedField, FieldKey, SheetAnalysis, SheetRole } from "./types";
import { normalizeText, parseNumber, similarity } from "./text";

const ALIASES: Record<FieldKey, string[]> = {
  entityId: [
    "entity id", "company id", "legal entity id", "entity code", "company code",
    "business unit", "business unit code", "business unit id", "business unit no", "bu",
    "company number", "company no", "entity number", "id entiteit", "societe code", "codigo sociedad",
  ],
  entityName: [
    "entity", "entity name", "company", "company name", "legal entity", "legal entity name",
    "subsidiary", "business unit name", "entiteit", "vennootschap", "gesellschaft", "societe",
    "sociedad", "societa", "denominazione", "raison sociale",
  ],
  parentEntity: [
    "parent", "parent entity", "parent company", "holding company", "direct parent", "immediate parent",
    "parent id", "parent code", "shareholder", "moedermaatschappij", "muttergesellschaft",
    "societe mere", "empresa matriz",
  ],
  ownershipPct: [
    "ownership", "ownership %", "ownership percentage", "shareholding", "shareholding %",
    "equity interest", "interest %", "participation %", "direct ownership", "owned %",
    "percentage held", "holding percentage", "belang", "aandelenbelang", "beteiligungsquote",
    "pourcentage detention", "participacion",
  ],
  country: [
    "country", "jurisdiction", "country code", "incorporation country", "domicile",
    "land", "staat", "pays", "pais", "paese",
  ],
  currency: [
    "currency", "currency code", "base currency", "reporting currency", "functional currency",
    "group currency", "company currency", "ledger currency", "local currency", "transaction currency",
    "document currency", "presentation currency", "base ccy", "reporting ccy", "functional ccy",
    "local ccy", "curr", "ccy", "valuta", "waehrung", "devise", "moneda",
  ],
  period: [
    "period", "reporting period", "quarter", "as of", "as at", "date", "year", "month",
    "fiscal year", "fiscal period", "posting period", "period end", "closing date",
    "periode", "rapportageperiode", "stichtag", "periodo",
  ],
  glAccount: [
    "gl account", "gl account number", "gl code", "account", "account number", "account no",
    "account code", "account id", "ledger account", "general ledger account", "natural account",
    "nominal account", "coa account", "chart of accounts code", "rekening", "grootboekrekening",
    "konto", "kontonummer", "compte", "numero de compte", "cuenta", "codigo cuenta", "conto",
  ],
  glDescription: [
    "gl description", "account description", "description", "account name", "account title", "account text",
    "ledger description", "account label", "natural account description", "label", "omschrijving",
    "rekeningomschrijving", "kontobezeichnung", "libelle", "descripcion", "descrizione",
  ],
  balance: [
    "closing balance", "ending balance", "end balance", "balance", "net balance", "period balance",
    "period end balance", "ytd balance", "ytd actual", "actual balance", "book balance",
    "closing amount", "ending amount", "net amount", "amount", "amt", "sum amount", "sum of amount",
    "sum transaction amt", "transaction amount", "transaction amt", "total amount", "base amount",
    "reporting amount", "functional amount", "group amount", "company amount", "consolidated amount",
    "translated amount", "local amount", "ledger amount", "actual amount", "amount in reporting currency",
    "amount in base currency", "saldo", "eindsaldo", "schlussbestand", "solde", "solde final",
    "montant", "balance final", "importe", "saldo finale", "valore",
  ],
  debit: [
    "debit", "debit amount", "debits", "debit balance", "dr amount", "dr", "debet", "soll",
    "debit movement", "debit montant",
  ],
  credit: [
    "credit", "credit amount", "credits", "credit balance", "cr amount", "cr", "credito", "haben",
    "credit movement", "credit montant",
  ],
  debitCredit: [
    "debit credit indicator", "debit credit", "debit/credit", "dr cr", "dr/cr", "d c",
    "dc indicator", "sign indicator", "balance indicator",
  ],
  accountCategory: [
    "account category", "account type", "category", "financial statement line", "fs category",
    "account grouping", "account group", "subgrouping", "subgrouping1", "subgrouping2",
    "subgrouping 1", "subgrouping 2", "sub grouping 1", "sub grouping 2", "account class",
    "financial statement category", "rekeningcategorie", "kontokategorie", "categorie", "categoria conto",
  ],
  balanceSheetSide: [
    "balance sheet side", "bs side", "asset liability", "assets liabilities", "statement side",
    "statement type", "financial statement", "grouping", "account side", "zijde", "bilanzseite",
    "etat financier",
  ],
  fairValue: [
    "fair value", "market value", "tax value", "adjusted value", "fmv", "fair market value",
    "reele waarde", "marktwaarde", "valeur de marche",
  ],
  bookValue: [
    "book value", "carrying value", "tb value", "ledger value", "boekwaarde", "buchwert", "valeur comptable",
  ],
  taxRate: [
    "tax rate", "corporate tax rate", "cit rate", "effective tax rate", "etr", "belastingtarief",
    "steuersatz", "taux impot",
  ],
  motiveTest: ["motive test", "motive", "investment motive", "oogmerktoets", "beleggingsoogmerk"],
  subjectToTaxTest: ["subject to tax", "subject to tax test", "taxation test", "onderworpenheidstoets"],
};

const FIELDS = Object.keys(ALIASES) as FieldKey[];
const NORMALIZED_ALIASES = Object.fromEntries(
  FIELDS.map((field) => [field, ALIASES[field].map(normalizeText)]),
) as Record<FieldKey, string[]>;

const EXACT_ALIAS_FIELDS = new Map<string, FieldKey[]>();
for (const field of FIELDS) {
  for (const alias of NORMALIZED_ALIASES[field]) {
    const existing = EXACT_ALIAS_FIELDS.get(alias) ?? [];
    existing.push(field);
    EXACT_ALIAS_FIELDS.set(alias, existing);
  }
}

const CONTAINMENT_ALIASES = FIELDS.flatMap((field) =>
  NORMALIZED_ALIASES[field]
    .filter((alias) => alias.includes(" ") && alias.length >= 6)
    .map((alias) => ({ field, alias })),
);

const ROLE_HINTS: Record<Exclude<SheetRole, "error">, string[]> = {
  structure: ["structure", "group structure", "ownership", "legal structure", "entities", "org chart", "deelnemingen", "participations", "shareholding"],
  trial_balance: ["trial balance", "tb", "ledger", "general ledger", "gl", "balance", "balances", "saldo", "saldi"],
  fair_value: ["fair value", "valuation", "adjustment", "fmv", "marktwaarde"],
  tax_master: ["tax master", "tax data", "tax rate", "subject to tax", "motive", "tax facts"],
  other: [],
};

interface HeaderCandidate {
  headerIndex: number;
  depth: number;
  fields: DetectedField[];
  role: SheetRole;
  score: number;
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

export function headerLabels(rows: unknown[][], headerIndex: number, depth = 1): string[] {
  const selectedRows = rows.slice(headerIndex, headerIndex + Math.max(1, depth));
  const width = Math.max(0, ...selectedRows.map((row) => row.length));
  return Array.from({ length: width }, (_, columnIndex) => {
    const parts: string[] = [];
    const seen = new Set<string>();
    for (const row of selectedRows) {
      const value = text(row[columnIndex]);
      const key = normalizeText(value);
      if (!value || !key || seen.has(key)) continue;
      seen.add(key);
      parts.push(value);
    }
    return parts.join(" / ");
  });
}

export function dataStartRowIndex(analysis: Pick<SheetAnalysis, "headerRow" | "headerDepth">): number {
  if (!analysis.headerRow) return 0;
  return analysis.headerRow - 1 + Math.max(1, analysis.headerDepth ?? 1);
}

function headerParts(value: unknown): string[] {
  const raw = text(value);
  const parts = raw.split(/\s*[|/]\s*/).map(normalizeText).filter(Boolean);
  const full = normalizeText(raw);
  return [...new Set([full, ...parts])];
}

function likelyFields(value: unknown): Set<FieldKey> {
  const result = new Set<FieldKey>();
  for (const normalized of headerParts(value)) {
    for (const field of EXACT_ALIAS_FIELDS.get(normalized) ?? []) result.add(field);
    for (const entry of CONTAINMENT_ALIASES) {
      if (normalized.includes(entry.alias)) result.add(entry.field);
      else if (normalized.split(" ").length >= 2 && entry.alias.includes(normalized)) result.add(entry.field);
    }
    // A currency code embedded in an amount header (for example "Amount EUR")
    // describes the amount column; it is not a separate currency field. Detect the
    // amount first so small or single-row trial balances are still recognised.
    if (/\b(amount|amt|balance|saldo|solde|montant|importe|value|closing|ending|net|total)\b/.test(normalized)) {
      result.add("balance");
    }
    if (extractCurrencyCode(normalized) && /\b(currency|ccy|valuta|waehrung|devise|moneda)\b/.test(normalized)) {
      result.add("currency");
    }
  }
  return result;
}

function quickHeaderCueCount(headers: string[]): number {
  return headers.filter((header) => likelyFields(header).size > 0).length;
}

function aliasScore(value: unknown, field: FieldKey): number {
  const parts = headerParts(value);
  const aliases = NORMALIZED_ALIASES[field];
  if (parts.some((part) => aliases.includes(part))) return 1;

  let best = 0;
  for (const part of parts) {
    for (const alias of aliases) {
      if (alias.includes(" ") && alias.length >= 6 && (part.includes(alias) || alias.includes(part))) {
        best = Math.max(best, 0.93);
        continue;
      }
      const partTokens = new Set(part.split(" ").filter((token) => token.length >= 3));
      const sharesToken = alias.split(" ").some((token) => token.length >= 3 && partTokens.has(token));
      if (!sharesToken) continue;
      best = Math.max(best, similarity(part, alias));
    }
  }
  return best;
}

function dataInferenceScore(field: FieldKey, values: unknown[]): number {
  const sample = values.filter((value) => text(value) !== "").slice(0, 60);
  if (sample.length < 2) return 0;

  const numeric = sample.map(parseNumber).filter((value): value is number => value !== null);
  const numericRatio = numeric.length / sample.length;
  const strings = sample.map(text);

  if (field === "ownershipPct" && numericRatio > 0.6) {
    const plausible = numeric.filter((number) => Math.abs(number) <= 100).length / numeric.length;
    return plausible * 0.58;
  }
  if (["balance", "debit", "credit"].includes(field) && numericRatio > 0.72) return 0.52;
  if (field === "period") {
    const plausible = strings.filter((value) => /^(19|20)\d{2}$/.test(value) || /q[1-4]/i.test(value) || !Number.isNaN(Date.parse(value))).length / sample.length;
    return plausible * 0.35;
  }
  if (field === "currency") {
    const plausible = strings.filter((value) => Boolean(extractCurrencyCode(value))).length / sample.length;
    return plausible * 0.74;
  }
  if (field === "debitCredit") {
    const plausible = strings.filter((value) => /^(?:d|dr|debit|debet|soll|c|cr|credit|credito|haben)$/i.test(value)).length / sample.length;
    return plausible * 0.7;
  }
  if (field === "country") {
    const plausible = strings.filter((value) => /^[A-Za-z]{2,3}$/.test(value) || /^[A-Za-z .'-]{4,30}$/.test(value)).length / sample.length;
    return plausible * 0.28;
  }
  if (field === "glAccount") {
    const plausible = strings.filter((value) => /^[A-Za-z0-9._/-]{2,30}$/.test(value)).length / sample.length;
    const unique = new Set(strings).size / sample.length;
    return plausible * Math.max(0.35, unique) * 0.42;
  }
  if (field === "entityId") {
    const plausible = strings.filter((value) => /^[A-Za-z0-9._/-]{2,30}$/.test(value)).length / sample.length;
    const counts = [...new Set(strings)].map((value) => strings.filter((candidate) => candidate === value).length);
    const dominant = Math.max(...counts, 0) / sample.length;
    return plausible * Math.max(0.35, dominant) * 0.38;
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

function detectFieldsForHeader(rows: unknown[][], headerIndex: number, depth: number): DetectedField[] {
  const headers = headerLabels(rows, headerIndex, depth);
  const candidates: Array<DetectedField & { score: number }> = [];
  const dataStart = headerIndex + depth;

  for (let columnIndex = 0; columnIndex < headers.length; columnIndex += 1) {
    const headerValue = headers[columnIndex];
    if (!headerValue) continue;
    const candidateFields = likelyFields(headerValue);
    if (!candidateFields.size) continue;
    const below = rows.slice(dataStart, dataStart + 61).map((row) => row[columnIndex]);
    for (const field of candidateFields) {
      const lexical = aliasScore(headerValue, field);
      const inferred = dataInferenceScore(field, below);
      const score = Math.min(1, lexical * 0.84 + inferred * 0.16);
      if (score >= 0.5) candidates.push({ field, columnIndex, header: headerValue, confidence: score, score });
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
  const hasAmount = names.has("balance") || (names.has("debit") && names.has("credit"));

  if (hasEntity && names.has("parentEntity") && names.has("ownershipPct")) return "structure";
  if (roleHint("structure") && hasEntity && names.has("ownershipPct")) return "structure";
  if (names.has("glAccount") && hasAmount) return "trial_balance";
  if (roleHint("trial_balance") && names.has("glAccount") && hasAmount) return "trial_balance";
  if (names.has("fairValue") && (names.has("glAccount") || hasEntity)) return "fair_value";
  if (roleHint("fair_value") && names.has("fairValue")) return "fair_value";
  if ((names.has("taxRate") || names.has("motiveTest") || names.has("subjectToTaxTest")) && hasEntity) return "tax_master";
  if (roleHint("tax_master") && (names.has("taxRate") || names.has("motiveTest") || names.has("subjectToTaxTest"))) return "tax_master";
  return "other";
}

function headerCandidateScore(role: SheetRole, fields: DetectedField[], depth: number): number {
  if (role === "other") return 0;
  const names = new Set(fields.map((field) => field.field));
  const strong = fields.filter((field) => field.confidence >= 0.74).length;
  const total = fields.reduce((sum, field) => sum + field.confidence, 0);
  let completeness = 0;
  if (role === "trial_balance") {
    if (names.has("glAccount")) completeness += 3;
    if (names.has("balance")) completeness += 3;
    if (names.has("debit") && names.has("credit")) completeness += 3;
    if (names.has("glDescription")) completeness += 1;
  } else if (role === "structure") {
    if (names.has("entityId") || names.has("entityName")) completeness += 2;
    if (names.has("parentEntity")) completeness += 2;
    if (names.has("ownershipPct")) completeness += 2;
  }
  const roleBonus = role === "trial_balance" || role === "structure" ? 4 : 2;
  return roleBonus + completeness + strong * 2 + total - (depth - 1) * 0.05;
}

function isCompleteRole(role: SheetRole, fields: DetectedField[]): boolean {
  const names = new Set(fields.map((field) => field.field));
  if (role === "trial_balance") return names.has("glAccount") && (names.has("balance") || (names.has("debit") && names.has("credit")));
  if (role === "structure") return (names.has("entityName") || names.has("entityId")) && names.has("ownershipPct");
  if (role === "fair_value") return names.has("fairValue") && (names.has("glAccount") || names.has("entityName") || names.has("entityId"));
  if (role === "tax_master") return (names.has("entityName") || names.has("entityId")) && (names.has("taxRate") || names.has("motiveTest") || names.has("subjectToTaxTest"));
  return false;
}

function candidateAtDepth(sheetName: string, rows: unknown[][], rowIndex: number, depth: number): HeaderCandidate | null {
  const headers = headerLabels(rows, rowIndex, depth);
  if (headers.filter(Boolean).length < 2 || quickHeaderCueCount(headers) < 2) return null;
  const fields = detectFieldsForHeader(rows, rowIndex, depth);
  const role = roleForFields(sheetName, fields);
  const score = headerCandidateScore(role, fields, depth);
  return role !== "other" && score >= 6 ? { headerIndex: rowIndex, depth, fields, role, score } : null;
}

function findCandidates(sheetName: string, rows: unknown[][]): HeaderCandidate[] {
  const scanLimit = Math.min(rows.length, 500);
  const candidates: HeaderCandidate[] = [];

  for (let rowIndex = 0; rowIndex < scanLimit; rowIndex += 1) {
    const singleRow = candidateAtDepth(sheetName, rows, rowIndex, 1);
    if (singleRow) {
      candidates.push(singleRow);
      if (isCompleteRole(singleRow.role, singleRow.fields)) continue;
    }

    for (let depth = 2; depth <= 3 && rowIndex + depth <= rows.length; depth += 1) {
      const candidate = candidateAtDepth(sheetName, rows, rowIndex, depth);
      if (!candidate) continue;
      candidates.push(candidate);
      if (isCompleteRole(candidate.role, candidate.fields)) break;
    }
  }

  candidates.sort((first, second) => first.headerIndex - second.headerIndex || second.score - first.score);
  const deduped: HeaderCandidate[] = [];
  for (const candidate of candidates) {
    const nearby = deduped.findIndex((existing) =>
      existing.role === candidate.role
      && Math.abs(existing.headerIndex - candidate.headerIndex) <= 2
      && existing.fields.some((field) => candidate.fields.some((other) => other.field === field.field && other.columnIndex === field.columnIndex)),
    );
    if (nearby < 0) deduped.push(candidate);
    else if (candidate.score > deduped[nearby].score) deduped[nearby] = candidate;
  }
  return deduped.sort((first, second) => first.headerIndex - second.headerIndex);
}

function toAnalysis(sheetName: string, rows: unknown[][], candidate: HeaderCandidate): SheetAnalysis {
  const nonEmptyRows = rows.filter((row) => row.some((value) => text(value) !== ""));
  const columnCount = Math.max(0, ...rows.map((row) => row.length));
  const names = new Set(candidate.fields.map((field) => field.field));
  const errors: string[] = [];
  const warnings: string[] = [];

  if (candidate.role === "structure") {
    if (!names.has("entityName") && !names.has("entityId")) errors.push("Entity/company column not detected.");
    if (!names.has("parentEntity")) warnings.push("Parent column not detected; entities may be treated as roots.");
    if (!names.has("ownershipPct")) errors.push("Ownership percentage column not detected.");
  }
  if (candidate.role === "trial_balance") {
    if (!names.has("glAccount")) errors.push("GL account column not detected.");
    if (!names.has("balance") && !(names.has("debit") && names.has("credit"))) errors.push("Balance column or debit/credit columns not detected.");
    if (!names.has("glDescription")) warnings.push("GL description column not detected; classification confidence will be lower.");
    if (!names.has("entityName") && !names.has("entityId")) warnings.push("No entity column detected; the entity will be inferred from the sheet or workbook context when possible.");
  }

  const confidence = candidate.fields.length
    ? candidate.fields.reduce((sum, field) => sum + field.confidence, 0) / candidate.fields.length
    : 0;
  if (confidence < 0.68) warnings.push("Low recognition confidence. Review detected columns before relying on the calculation.");
  if (candidate.depth > 1) warnings.push(`Combined ${candidate.depth} header rows to recognise this table.`);

  return {
    sheetName,
    rowCount: nonEmptyRows.length,
    columnCount,
    headerRow: candidate.headerIndex + 1,
    headerDepth: candidate.depth,
    role: errors.length ? "error" : candidate.role,
    confidence,
    fields: candidate.fields,
    errors,
    warnings,
  };
}

export function analyseSheetTables(sheetName: string, rows: unknown[][]): SheetAnalysis[] {
  const candidates = findCandidates(sheetName, rows);
  const analyses = candidates.map((candidate) => toAnalysis(sheetName, rows, candidate));
  return analyses.map((analysis, index) => ({ ...analysis, tableIndex: index + 1, tableCount: analyses.length }));
}

export function analyseSheet(sheetName: string, rows: unknown[][]): SheetAnalysis {
  const candidates = findCandidates(sheetName, rows);
  const nonEmptyRows = rows.filter((row) => row.some((value) => text(value) !== ""));
  const columnCount = Math.max(0, ...rows.map((row) => row.length));

  if (!candidates.length) {
    return {
      sheetName,
      rowCount: nonEmptyRows.length,
      columnCount,
      headerRow: null,
      headerDepth: 1,
      role: "other",
      confidence: 0,
      fields: [],
      errors: [],
      warnings: [],
    };
  }

  const best = [...candidates].sort((first, second) => second.score - first.score)[0];
  const analysis = toAnalysis(sheetName, rows, best);
  if (candidates.length > 1) analysis.warnings.push(`${candidates.length} structured table blocks were detected on this worksheet.`);
  return analysis;
}

export function fieldMap(analysis: SheetAnalysis): Partial<Record<FieldKey, number>> {
  return Object.fromEntries(analysis.fields.map((field) => [field.field, field.columnIndex]));
}
