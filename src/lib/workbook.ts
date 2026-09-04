import { classifyAccount, isAssetClass, mappingKey } from "./classification";
import { analyseSheet, analyseSheetTables, dataStartRowIndex, fieldMap, headerLabels } from "./fieldDetection";
import { normalizeKey, normalizeText, parseNumber, parsePercentage, similarity, slug } from "./text";
import { dominantCurrencyCode, extractCurrencyCode, uniqueCurrencyCode } from "./currency";
import type {
  AccountMapping,
  EntityRecord,
  EntityTaxData,
  FairValueAdjustment,
  ImportResult,
  SheetAnalysis,
  TestState,
  TrialBalanceLine,
} from "./types";

interface AnalysedSheet {
  analysis: SheetAnalysis;
  rows: unknown[][];
  dataEndRow?: number;
}

interface TrialColumns {
  entityId?: number;
  entityName?: number;
  glAccount?: number;
  glDescription?: number;
  balance?: number;
  debit?: number;
  credit?: number;
  debitCredit?: number;
  currency?: number;
  fixedCurrencyCode?: string;
  amountMode?: "balance" | "debit_credit";
  period?: number;
  accountCategory?: number;
  balanceSheetSide?: number;
  grouping?: number;
  subgrouping1?: number;
  subgrouping2?: number;
  counterparty?: number;
  selectionNote?: string;
  selectionWarning?: string;
  selectionError?: string;
}

export interface WorkbookSheetRows {
  sheetName: string;
  rows: unknown[][];
}

function cell(row: unknown[], index: number | undefined): unknown {
  return index === undefined ? "" : row[index];
}

function asString(value: unknown): string {
  return String(value ?? "").trim();
}

function uniqueText(values: unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const text = asString(value);
    const key = normalizeKey(text);
    if (!text || !key || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function parseTestState(value: unknown): TestState | undefined {
  const text = normalizeText(value);
  if (!text) return undefined;
  if (["pass", "passed", "yes", "true", "qualifies", "non investment", "not investment", "zakelijk"].some((candidate) => text === candidate || text.includes(candidate))) return "PASS";
  if (["fail", "failed", "no", "false", "does not qualify", "investment"].some((candidate) => text === candidate || text.includes(candidate))) return "FAIL";
  if (text.includes("review") || text.includes("uncertain") || text.includes("tbd")) return "REVIEW";
  if (text.includes("not assessed") || text.includes("n a") || text.includes("unknown")) return "NOT_ASSESSED";
  return undefined;
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function inferPeriod(fileName: string, values: string[], sheets: AnalysedSheet[]): string | undefined {
  const q = fileName.match(/\bQ([1-4])[_ -]?(20\d{2})\b/i) ?? fileName.match(/\b(20\d{2})[_ -]?Q([1-4])\b/i);
  if (q) {
    if (q[1]?.length === 1) return `Q${q[1]} ${q[2]}`;
    return `Q${q[2]} ${q[1]}`;
  }

  const date = fileName.match(/\b(20\d{2})[-_ ]?(0[1-9]|1[0-2])[-_ ]?([0-3]\d)\b/);
  if (date) return `${date[1]}-${date[2]}-${date[3]}`;

  const fileText = normalizeText(fileName);
  for (const month of MONTHS) {
    const monthYear = fileText.match(new RegExp(`\\b${month}\\s+(20\\d{2})\\b`));
    if (monthYear) return `${titleCase(month)} ${monthYear[1]}`;
    const yearMonth = fileText.match(new RegExp(`\\b(20\\d{2})\\s+${month}\\b`));
    if (yearMonth) return `${titleCase(month)} ${yearMonth[1]}`;
  }

  const contextValues = sheets.flatMap(({ rows }) => rows.slice(0, 12).flat().map(asString).filter(Boolean));
  for (const text of contextValues) {
    const normalized = normalizeText(text);
    for (const month of MONTHS) {
      const match = normalized.match(new RegExp(`(?:as at|ended|period ended)?\\s*(?:[0-3]?\\d\\s+)?${month}\\s+(20\\d{2})`));
      if (match) return `${titleCase(month)} ${match[1]}`;
    }
  }

  const candidates = values.filter(Boolean);
  if (candidates.length) {
    const counts = new Map<string, number>();
    for (const candidate of candidates) counts.set(candidate, (counts.get(candidate) ?? 0) + 1);
    return [...counts.entries()].sort((first, second) => second[1] - first[1])[0]?.[0];
  }
  return undefined;
}

function getRows(XLSX: typeof import("xlsx"), workbook: import("xlsx").WorkBook, sheetName: string): unknown[][] {
  const worksheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    defval: "",
    raw: true,
    blankrows: true,
  }) as unknown[][];

  // Expand small merged header ranges so two- and three-row headers can be interpreted.
  // Large title merges are deliberately ignored to avoid copying a title over every column.
  for (const merge of worksheet["!merges"] ?? []) {
    const rowSpan = merge.e.r - merge.s.r + 1;
    const columnSpan = merge.e.c - merge.s.c + 1;
    if (rowSpan > 3 || columnSpan > 12) continue;
    const value = rows[merge.s.r]?.[merge.s.c];
    if (asString(value) === "") continue;
    for (let rowIndex = merge.s.r; rowIndex <= merge.e.r; rowIndex += 1) {
      rows[rowIndex] ??= [];
      for (let columnIndex = merge.s.c; columnIndex <= merge.e.c; columnIndex += 1) {
        if (asString(rows[rowIndex][columnIndex]) === "") rows[rowIndex][columnIndex] = value;
      }
    }
  }
  return rows;
}

function headerValues(rows: unknown[][], analysis: SheetAnalysis): string[] {
  if (!analysis.headerRow) return [];
  return headerLabels(rows, analysis.headerRow - 1, analysis.headerDepth ?? 1).map(asString);
}

function findHeaderIndex(headers: string[], aliases: string[]): number | undefined {
  const normalizedAliases = aliases.map(normalizeText);
  const exact = headers.findIndex((header) => normalizedAliases.includes(normalizeText(header)));
  if (exact >= 0) return exact;
  const contained = headers.findIndex((header) => normalizedAliases.some((alias) => normalizeText(header).includes(alias)));
  return contained >= 0 ? contained : undefined;
}

function numericRatio(rows: unknown[][], dataStart: number, dataEnd: number, columnIndex: number): number {
  const sample = rows.slice(dataStart, Math.min(dataEnd, dataStart + 80)).map((row) => cell(row, columnIndex)).filter((value) => asString(value) !== "");
  if (!sample.length) return 0;
  return sample.filter((value) => parseNumber(value) !== null).length / sample.length;
}

interface CurrencyColumnCandidate {
  columnIndex: number;
  header: string;
  normalized: string;
  code?: string;
  reportingScore: number;
}

interface AmountColumnCandidate {
  columnIndex: number;
  header: string;
  normalized: string;
  numeric: number;
  code?: string;
  currencyColumn?: CurrencyColumnCandidate;
  score: number;
}

const REPORTING_TERMS = /\b(reporting|base|functional|group|consolidated|consolidation|translated|presentation)\b/;
const LOCAL_TERMS = /\b(transaction|document|original|source|local)\b/;
const AMOUNT_TERMS = /\b(amount|amt|balance|saldo|solde|importe|value|closing|ending|net|total)\b/;

function detectCurrencyColumns(rows: unknown[][], headers: string[], dataStart: number, dataEnd: number): CurrencyColumnCandidate[] {
  return headers.flatMap((header, columnIndex) => {
    const normalized = normalizeText(header);
    const values = rows.slice(dataStart, Math.min(dataEnd, dataStart + 100)).map((row) => cell(row, columnIndex));
    const code = dominantCurrencyCode(values, 0.65) ?? extractCurrencyCode(header);
    const looksLikeCurrency = /\b(currency|ccy|valuta|waehrung|devise|moneda)\b/.test(normalized);
    if (!looksLikeCurrency && !code) return [];
    let reportingScore = 0;
    if (REPORTING_TERMS.test(normalized)) reportingScore += 8;
    if (LOCAL_TERMS.test(normalized)) reportingScore -= 6;
    return [{ columnIndex, header, normalized, code, reportingScore }];
  });
}

function bestCurrencyColumn(amountIndex: number, amountHeader: string, currencyColumns: CurrencyColumnCandidate[]): CurrencyColumnCandidate | undefined {
  const amountIsReporting = REPORTING_TERMS.test(amountHeader);
  const amountIsLocal = LOCAL_TERMS.test(amountHeader);
  return currencyColumns
    .map((candidate) => {
      const distance = Math.abs(candidate.columnIndex - amountIndex);
      const currencyIsReporting = REPORTING_TERMS.test(candidate.normalized);
      const currencyIsLocal = LOCAL_TERMS.test(candidate.normalized);
      let score = candidate.reportingScore;
      if (distance === 1) score += 7;
      else if (distance === 2) score += 3;
      else if (distance > 4) score -= distance;
      if (candidate.columnIndex < amountIndex) score += 1;
      if ((amountIsReporting && currencyIsReporting) || (amountIsLocal && currencyIsLocal)) score += 10;
      if ((amountIsReporting && currencyIsLocal) || (amountIsLocal && currencyIsReporting)) score -= 10;
      return { candidate, score };
    })
    .sort((first, second) => second.score - first.score)[0]?.candidate;
}

function resolveTrialColumns(rows: unknown[][], analysis: SheetAnalysis, dataEnd = rows.length): TrialColumns {
  const map = fieldMap(analysis);
  const headers = headerValues(rows, analysis);
  const dataStart = dataStartRowIndex(analysis);
  const currencyColumns = detectCurrencyColumns(rows, headers, dataStart, dataEnd);

  const amountCandidates: AmountColumnCandidate[] = headers
    .flatMap((header, columnIndex): AmountColumnCandidate[] => {
      const normalized = normalizeText(header);
      const numeric = numericRatio(rows, dataStart, dataEnd, columnIndex);
      const explicitlyDetected = [map.balance, map.debit, map.credit].includes(columnIndex);
      if (numeric < 0.62 || (!AMOUNT_TERMS.test(normalized) && !explicitlyDetected)) return [];
      if (/\b(rate|percentage|ownership|year|period|account|code|id)\b/.test(normalized) && !/\b(amount|balance|saldo|solde|importe)\b/.test(normalized)) return [];

      const currencyColumn = bestCurrencyColumn(columnIndex, normalized, currencyColumns);
      let score = numeric * 2;
      if (columnIndex === map.balance) score += 3;
      if (REPORTING_TERMS.test(normalized)) score += 10;
      if (LOCAL_TERMS.test(normalized)) score -= 9;
      if (/\b(sum|closing|ending|period end|net|total)\b/.test(normalized)) score += 2;
      if (/\b(debit|credit|dr|cr)\b/.test(normalized)) score -= 5;
      if (currencyColumn) {
        score += currencyColumn.reportingScore;
        const distance = Math.abs(currencyColumn.columnIndex - columnIndex);
        if (distance === 1) score += 6;
        else if (distance === 2) score += 2;
      }
      const code = extractCurrencyCode(header) ?? currencyColumn?.code;
      if (code) score += 1;
      return [{ columnIndex, header, normalized, numeric, code, currencyColumn, score }];
    })
    .sort((first, second) => second.score - first.score);

  const hasDebitCredit = map.debit !== undefined && map.credit !== undefined;
  const balanceCandidates = hasDebitCredit
    ? amountCandidates.filter((candidate) => candidate.columnIndex !== map.debit && candidate.columnIndex !== map.credit)
    : amountCandidates;
  const selectedAmount = balanceCandidates[0];
  const secondAmount = balanceCandidates[1];
  const balance = selectedAmount?.columnIndex ?? map.balance;
  const amountMode: TrialColumns["amountMode"] = balance !== undefined ? "balance" : hasDebitCredit ? "debit_credit" : undefined;

  const entityId = map.entityId ?? findHeaderIndex(headers, ["bu", "business unit", "business unit code", "entity id", "entity code", "company code"]);
  const entityName = map.entityName ?? findHeaderIndex(headers, ["entity", "entity name", "company", "company name", "legal entity"]);
  const grouping = findHeaderIndex(headers, ["grouping", "statement type", "financial statement"]);
  const subgrouping1 = findHeaderIndex(headers, ["subgrouping1", "subgrouping 1", "sub grouping 1", "account group"]);
  const subgrouping2 = findHeaderIndex(headers, ["subgrouping2", "subgrouping 2", "sub grouping 2", "account subgroup"]);
  const counterparty = findHeaderIndex(headers, ["affl", "affiliate", "affiliate code", "counterparty", "related party", "intercompany partner"]);

  const selectedCurrencyColumn = selectedAmount?.currencyColumn ?? currencyColumns.find((candidate) => candidate.columnIndex === map.currency) ?? currencyColumns[0];
  const contextValues = [
    analysis.sheetName,
    ...rows.slice(0, dataStart).flat(),
    ...headers,
  ];
  const fixedCurrencyCode = selectedAmount?.code ?? selectedCurrencyColumn?.code ?? uniqueCurrencyCode(contextValues);

  let selectionNote: string | undefined;
  if (amountMode === "balance" && selectedAmount) {
    const currencyDescription = fixedCurrencyCode ? ` in ${fixedCurrencyCode}` : "";
    selectionNote = `Using '${selectedAmount.header}'${currencyDescription} as the calculation balance.`;
  } else if (amountMode === "debit_credit") {
    selectionNote = `Using '${headers[map.debit ?? -1]}' less '${headers[map.credit ?? -1]}' as the signed balance.`;
  }

  let selectionWarning: string | undefined;
  let selectionError: string | undefined;
  if (selectedAmount && secondAmount) {
    const selectedIsDirected = REPORTING_TERMS.test(selectedAmount.normalized) || LOCAL_TERMS.test(selectedAmount.normalized);
    const secondIsDirected = REPORTING_TERMS.test(secondAmount.normalized) || LOCAL_TERMS.test(secondAmount.normalized);
    if (selectedAmount.code && secondAmount.code && selectedAmount.code !== secondAmount.code && !selectedIsDirected && !secondIsDirected) {
      selectionError = `Multiple plausible amount columns were detected ('${selectedAmount.header}' and '${secondAmount.header}') with different currencies. Identify a reporting/base amount column before calculating.`;
    } else if (selectedAmount.score - secondAmount.score < 2) {
      selectionWarning = `Multiple amount columns were plausible. '${selectedAmount.header}' was selected over '${secondAmount.header}'. Review the detected balance before relying on the result.`;
    }
  }

  return {
    entityId,
    entityName,
    glAccount: map.glAccount,
    glDescription: map.glDescription,
    balance,
    debit: map.debit,
    credit: map.credit,
    debitCredit: map.debitCredit,
    amountMode,
    currency: selectedCurrencyColumn?.columnIndex ?? map.currency,
    fixedCurrencyCode,
    period: map.period,
    accountCategory: map.accountCategory,
    balanceSheetSide: map.balanceSheetSide,
    grouping,
    subgrouping1,
    subgrouping2,
    counterparty,
    selectionNote,
    selectionWarning,
    selectionError,
  };
}

function updateTrialAnalysisFields(sheet: AnalysedSheet): void {
  if (sheet.analysis.role !== "trial_balance" || !sheet.analysis.headerRow) return;
  const columns = resolveTrialColumns(sheet.rows, sheet.analysis, sheet.dataEndRow);
  const headers = headerValues(sheet.rows, sheet.analysis);
  const updates: Array<{ field: "entityId" | "balance" | "debit" | "credit" | "currency" | "accountCategory" | "balanceSheetSide"; index: number | undefined }> = [
    { field: "entityId", index: columns.entityId },
    { field: "balance", index: columns.amountMode === "balance" ? columns.balance : undefined },
    { field: "debit", index: columns.amountMode === "debit_credit" ? columns.debit : undefined },
    { field: "credit", index: columns.amountMode === "debit_credit" ? columns.credit : undefined },
    { field: "currency", index: columns.currency },
    { field: "accountCategory", index: columns.subgrouping2 ?? columns.accountCategory },
    { field: "balanceSheetSide", index: columns.grouping ?? columns.balanceSheetSide },
  ];

  for (const update of updates) {
    if (update.index === undefined) continue;
    const existing = sheet.analysis.fields.find((field) => field.field === update.field);
    if (existing) {
      existing.columnIndex = update.index;
      existing.header = headers[update.index] ?? existing.header;
      existing.confidence = Math.max(existing.confidence, 0.92);
    } else {
      sheet.analysis.fields.push({ field: update.field, columnIndex: update.index, header: headers[update.index] ?? "", confidence: 0.92 });
    }
  }
  if (columns.selectionError) {
    if (!sheet.analysis.errors.includes(columns.selectionError)) sheet.analysis.errors.push(columns.selectionError);
  } else {
    if (columns.selectionNote && !sheet.analysis.warnings.includes(columns.selectionNote)) sheet.analysis.warnings.push(columns.selectionNote);
    if (columns.selectionWarning && !sheet.analysis.warnings.includes(columns.selectionWarning)) sheet.analysis.warnings.push(columns.selectionWarning);
  }
  sheet.analysis.confidence = sheet.analysis.fields.reduce((sum, field) => sum + field.confidence, 0) / sheet.analysis.fields.length;
}

function tableContextStrings(sheetName: string, rows: unknown[][], analysis: SheetAnalysis): string[] {
  const headerIndex = analysis.headerRow ? analysis.headerRow - 1 : 0;
  const localStart = Math.max(0, headerIndex - 12);
  return uniqueText([
    sheetName,
    ...rows.slice(0, 12).flatMap((row) => row.slice(0, 12)),
    ...rows.slice(localStart, headerIndex).flatMap((row) => row.slice(0, 12)),
  ]);
}

function inferEntityFromContext(sheetName: string, rows: unknown[][], analysis: SheetAnalysis, entities: EntityRecord[]): EntityRecord | null {
  if (entities.length === 1) return entities[0];
  if (!entities.length) return null;
  const context = tableContextStrings(sheetName, rows, analysis).join(" ");
  const ranked = entities
    .map((entity) => ({
      entity,
      score: Math.max(
        similarity(sheetName, entity.name),
        similarity(sheetName, entity.id),
        similarity(context, entity.name),
        similarity(context, entity.id),
      ),
    }))
    .sort((first, second) => second.score - first.score);
  if (!ranked[0] || ranked[0].score < 0.56) return null;
  if (ranked[1] && ranked[0].score - ranked[1].score < 0.06) return null;
  return ranked[0].entity;
}

function buildEntities(structureSheets: AnalysedSheet[], errors: string[], warnings: string[]): EntityRecord[] {
  const raw: Array<EntityRecord & { parentRaw?: string }> = [];

  for (const { analysis, rows, dataEndRow } of structureSheets) {
    if (!analysis.headerRow) continue;
    const map = fieldMap(analysis);
    const endRow = dataEndRow ?? rows.length;
    for (let rowIndex = dataStartRowIndex(analysis); rowIndex < endRow; rowIndex += 1) {
      const row = rows[rowIndex];
      const name = asString(cell(row, map.entityName));
      const explicitId = asString(cell(row, map.entityId));
      if (!name && !explicitId) continue;
      const entityName = name || explicitId;
      const parentRaw = asString(cell(row, map.parentEntity));
      const ownershipRaw = cell(row, map.ownershipPct);
      const ownership = parentRaw ? parsePercentage(ownershipRaw) : 100;
      if (parentRaw && (ownership === null || ownership <= 0 || ownership > 100)) {
        errors.push(`${analysis.sheetName} row ${rowIndex + 1}: invalid ownership percentage for ${entityName}.`);
        continue;
      }
      raw.push({
        id: explicitId || slug(entityName),
        name: entityName,
        parentId: null,
        parentName: parentRaw || null,
        parentRaw,
        ownershipPct: ownership ?? 100,
        ownershipProvided: Boolean(parentRaw && ownershipRaw !== ""),
        source: "structure",
        country: asString(cell(row, map.country)) || undefined,
        currency: extractCurrencyCode(cell(row, map.currency)),
      });
    }
  }

  const deduped = new Map<string, EntityRecord & { parentRaw?: string }>();
  for (const entity of raw) {
    const key = normalizeKey(entity.id || entity.name);
    if (deduped.has(key)) {
      const existing = deduped.get(key)!;
      if (normalizeKey(existing.name) !== normalizeKey(entity.name)) warnings.push(`Duplicate entity identifier ${entity.id} detected; first occurrence retained.`);
      continue;
    }
    deduped.set(key, entity);
  }

  const entities = [...deduped.values()];
  const byId = new Map(entities.map((entity) => [normalizeKey(entity.id), entity]));
  const byName = new Map(entities.map((entity) => [normalizeKey(entity.name), entity]));
  for (const entity of entities) {
    if (!entity.parentRaw || ["-", "n/a", "na", "none"].includes(normalizeText(entity.parentRaw))) continue;
    const parent = byId.get(normalizeKey(entity.parentRaw)) ?? byName.get(normalizeKey(entity.parentRaw));
    if (!parent) {
      errors.push(`Parent '${entity.parentRaw}' for ${entity.name} was not found in the detected structure.`);
      continue;
    }
    if (parent.id === entity.id) {
      errors.push(`${entity.name} cannot be its own parent.`);
      continue;
    }
    entity.parentId = parent.id;
  }

  const seen = new Set<string>();
  const active = new Set<string>();
  const byEntityId = new Map(entities.map((entity) => [entity.id, entity]));
  const visit = (id: string) => {
    if (active.has(id)) {
      errors.push(`Circular ownership detected involving ${byEntityId.get(id)?.name ?? id}.`);
      return;
    }
    if (seen.has(id)) return;
    active.add(id);
    const parent = byEntityId.get(id)?.parentId;
    if (parent) visit(parent);
    active.delete(id);
    seen.add(id);
  };
  entities.forEach((entity) => visit(entity.id));

  const childrenByParent = new Map<string, EntityRecord[]>();
  for (const entity of entities) {
    if (!entity.parentId) continue;
    const children = childrenByParent.get(entity.parentId) ?? [];
    children.push(entity);
    childrenByParent.set(entity.parentId, children);
  }
  for (const [parentId, children] of childrenByParent) {
    const total = children.reduce((sum, child) => sum + child.ownershipPct, 0);
    if (total > 100.0001) warnings.push(`Direct ownership percentages below ${byEntityId.get(parentId)?.name ?? parentId} total ${total.toFixed(1)}%. This may be valid for different share classes, but requires review.`);
  }

  return entities.map(({ parentRaw: _parentRaw, ...entity }) => entity);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function workbookContextStrings(sheets: AnalysedSheet[]): string[] {
  return uniqueText(
    sheets.flatMap(({ rows }) => rows.slice(0, 12).flatMap((row) => row.slice(0, 12))).filter((value) => typeof value === "string"),
  );
}

function bestNameForEntityId(entityId: string, sheets: AnalysedSheet[]): string | undefined {
  const candidates = workbookContextStrings(sheets);
  const escaped = escapeRegExp(entityId);
  const idPattern = new RegExp(`^\\s*${escaped}\\s*[-:|]\\s*(.+)$`, "i");
  const generic = /\b(statement|trial balance|balance sheet|period|year ended|as at|test|report)\b/i;
  const legal = /\b(limited|ltd|b\.?v\.?|n\.?v\.?|gmbh|s\.?a\.?|sarl|sas|inc|llc|plc|company|corporation|pte|pty|oy|ab|aps|spa|srl|sl)\b/i;

  return candidates
    .map((candidate) => {
      const match = candidate.match(idPattern);
      const name = match?.[1]?.trim() || candidate.trim();
      let score = 0;
      if (normalizeKey(candidate).includes(normalizeKey(entityId))) score += 8;
      if (match) score += 7;
      if (legal.test(name)) score += 5;
      if (name.length >= 4 && name.length <= 140) score += 2;
      if (generic.test(name)) score -= 8;
      return { name, score };
    })
    .filter((candidate) => candidate.score >= 7 && normalizeKey(candidate.name) !== normalizeKey(entityId))
    .sort((first, second) => second.score - first.score || second.name.length - first.name.length)[0]?.name;
}

interface ContextIdentity {
  id: string;
  name: string;
  currency?: string;
}

function identityFromTableContext(sheet: AnalysedSheet): ContextIdentity | undefined {
  const values = tableContextStrings(sheet.analysis.sheetName, sheet.rows, sheet.analysis);
  const generic = /\b(trial balance|balance sheet|income statement|profit and loss|general ledger|statement|report|period|year ended|month ended|as at)\b/i;
  const legal = /\b(limited|ltd|b\.?v\.?|n\.?v\.?|gmbh|s\.?a\.?|sarl|sas|inc|llc|plc|company|corporation|pte|pty|oy|ab|aps|spa|srl|sl)\b/i;

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index].trim();
    const labelled = value.match(/^\s*(?:entity|entity name|company|company name|legal entity|business unit)\s*[:=-]\s*(.{2,140})$/i);
    if (labelled && !generic.test(labelled[1])) {
      const name = labelled[1].trim();
      return { id: slug(name), name, currency: uniqueCurrencyCode(values) };
    }
    if (/^(?:entity|entity name|company|company name|legal entity|business unit)$/i.test(value)) {
      const next = values[index + 1]?.trim();
      if (next && !generic.test(next)) return { id: slug(next), name: next, currency: uniqueCurrencyCode(values) };
    }
  }

  const codeAndName = values
    .map((value) => value.match(/^\s*([A-Za-z][A-Za-z0-9._/-]{1,24})\s*[-:|]\s*(.{4,140})$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({ id: match[1].trim(), name: match[2].trim() }))
    .filter((candidate) => !generic.test(candidate.name))
    .sort((first, second) => Number(legal.test(second.name)) - Number(legal.test(first.name)))[0];
  if (codeAndName) return { ...codeAndName, currency: uniqueCurrencyCode(values) };

  const legalName = values.find((value) => legal.test(value) && !generic.test(value) && value.length <= 140);
  if (legalName) return { id: slug(legalName), name: legalName, currency: uniqueCurrencyCode(values) };

  const sheetName = sheet.analysis.sheetName.trim();
  if (sheetName && !/^(tb|gl|trial balance|ledger|data|sheet\d*|balances?)$/i.test(sheetName) && !generic.test(sheetName)) {
    return { id: slug(sheetName), name: sheetName, currency: uniqueCurrencyCode(values) };
  }
  return undefined;
}

function inferEntitiesFromTrialSheets(trialSheets: AnalysedSheet[], allSheets: AnalysedSheet[]): EntityRecord[] {
  const inferred = new Map<string, { id: string; name?: string; currency?: string; source: EntityRecord["source"] }>();

  for (const sheet of trialSheets) {
    if (!sheet.analysis.headerRow) continue;
    const columns = resolveTrialColumns(sheet.rows, sheet.analysis, sheet.dataEndRow);
    const endRow = sheet.dataEndRow ?? sheet.rows.length;
    let explicitRowsFound = false;
    for (let rowIndex = dataStartRowIndex(sheet.analysis); rowIndex < endRow; rowIndex += 1) {
      const row = sheet.rows[rowIndex];
      const idRaw = asString(cell(row, columns.entityId));
      const nameRaw = asString(cell(row, columns.entityName));
      if (!idRaw && !nameRaw) continue;
      explicitRowsFound = true;
      const id = idRaw || slug(nameRaw);
      const key = normalizeKey(id);
      if (!key) continue;
      const existing = inferred.get(key);
      const currency = columns.fixedCurrencyCode ?? extractCurrencyCode(cell(row, columns.currency));
      inferred.set(key, {
        id,
        name: existing?.name || nameRaw || undefined,
        currency: existing?.currency || currency,
        source: "trial_balance",
      });
    }

    if (!explicitRowsFound) {
      const contextIdentity = identityFromTableContext(sheet);
      if (contextIdentity) {
        const key = normalizeKey(contextIdentity.id || contextIdentity.name);
        const existing = inferred.get(key);
        inferred.set(key, {
          id: contextIdentity.id,
          name: existing?.name || contextIdentity.name,
          currency: existing?.currency || columns.fixedCurrencyCode || contextIdentity.currency,
          source: "workbook_context",
        });
      }
    }
  }

  if (!inferred.size) {
    for (const context of workbookContextStrings(allSheets)) {
      const match = context.match(/^\s*([A-Za-z][A-Za-z0-9._/-]{1,24})\s*[-:|]\s*(.{4,140})$/);
      if (!match) continue;
      const id = match[1].trim();
      const name = match[2].trim();
      if (/\b(statement|period|year ended|test|report)\b/i.test(name)) continue;
      inferred.set(normalizeKey(id), { id, name, source: "workbook_context" });
    }
  }

  return [...inferred.values()].map((entity) => {
    const contextualName = bestNameForEntityId(entity.id, allSheets);
    return {
      id: entity.id,
      name: entity.name || contextualName || entity.id,
      parentId: null,
      parentName: null,
      ownershipPct: 100,
      ownershipProvided: false,
      source: entity.source,
      currency: entity.currency,
    };
  });
}

function applySavedMapping(base: AccountMapping, savedMappings: Record<string, AccountMapping>): AccountMapping {
  const saved = savedMappings[base.key];
  return saved ? { ...saved, source: "saved_mapping" } : base;
}

function creditValuesAreSigned(rows: unknown[][], analysis: SheetAnalysis, creditColumn: number | undefined, dataEnd = rows.length): boolean {
  if (creditColumn === undefined) return false;
  const values = rows
    .slice(dataStartRowIndex(analysis), Math.min(dataEnd, dataStartRowIndex(analysis) + 100))
    .map((row) => parseNumber(cell(row, creditColumn)))
    .filter((value): value is number => value !== null && Math.abs(value) > 0.000001);
  if (!values.length) return false;
  return values.filter((value) => value < 0).length / values.length >= 0.7;
}

function rowAmount(row: unknown[], columns: TrialColumns, signedCredit: boolean): number | null {
  if (columns.amountMode === "balance" || columns.balance !== undefined) {
    const amount = parseNumber(cell(row, columns.balance));
    if (amount === null) return null;
    const indicator = normalizeText(cell(row, columns.debitCredit));
    if (/^(c|cr|credit|credito|haben)$/.test(indicator)) return -Math.abs(amount);
    if (/^(d|dr|debit|debet|soll)$/.test(indicator)) return Math.abs(amount);
    return amount;
  }
  if (columns.amountMode !== "debit_credit") return null;
  const debit = parseNumber(cell(row, columns.debit));
  const credit = parseNumber(cell(row, columns.credit));
  if (debit === null && credit === null) return null;
  return (debit ?? 0) + (signedCredit ? (credit ?? 0) : -(credit ?? 0));
}

function parseTrialBalanceLines(
  trialSheets: AnalysedSheet[],
  entities: EntityRecord[],
  savedMappings: Record<string, AccountMapping>,
  errors: string[],
  warnings: string[],
): { lines: TrialBalanceLine[]; periods: string[] } {
  const allLines: TrialBalanceLine[] = [];
  const periods: string[] = [];
  const byId = new Map(entities.map((entity) => [normalizeKey(entity.id), entity]));
  const byName = new Map(entities.map((entity) => [normalizeKey(entity.name), entity]));

  for (const { analysis, rows, dataEndRow } of trialSheets) {
    if (!analysis.headerRow) continue;
    const endRow = dataEndRow ?? rows.length;
    const columns = resolveTrialColumns(rows, analysis, endRow);
    const fallbackEntity = inferEntityFromContext(analysis.sheetName, rows, analysis, entities);
    const signedCredit = creditValuesAreSigned(rows, analysis, columns.credit, endRow);
    if (columns.amountMode === "debit_credit" && signedCredit) {
      warnings.push(`${analysis.sheetName}: credit values appear to be signed already; debit and credit columns were added instead of subtracting credit.`);
    }
    const sheetLines: TrialBalanceLine[] = [];
    const unresolvedEntityRows: Array<{ rowNumber: number; glAccount: string }> = [];

    for (let rowIndex = dataStartRowIndex(analysis); rowIndex < endRow; rowIndex += 1) {
      const row = rows[rowIndex];
      const glAccount = asString(cell(row, columns.glAccount));
      const rawAmount = rowAmount(row, columns, signedCredit);
      const normalisedGl = normalizeText(glAccount);
      if (!glAccount && rawAmount === null) continue;
      if (/^(gl )?account( number| no| code)?$/.test(normalisedGl) || /^(grand )?(sub)?total$/.test(normalisedGl)) continue;
      if (!glAccount) {
        warnings.push(`${analysis.sheetName} row ${rowIndex + 1}: amount found without a GL account; row ignored.`);
        continue;
      }
      if (rawAmount === null) {
        warnings.push(`${analysis.sheetName} row ${rowIndex + 1}: GL ${glAccount} has no readable numeric balance; row ignored.`);
        continue;
      }

      const entityRaw = asString(cell(row, columns.entityId)) || asString(cell(row, columns.entityName));
      const entity = entityRaw ? byId.get(normalizeKey(entityRaw)) ?? byName.get(normalizeKey(entityRaw)) : fallbackEntity;
      if (!entity) {
        unresolvedEntityRows.push({ rowNumber: rowIndex + 1, glAccount });
        continue;
      }

      const description = asString(cell(row, columns.glDescription)) || glAccount;
      const grouping = asString(cell(row, columns.grouping));
      const subgrouping1 = asString(cell(row, columns.subgrouping1));
      const subgrouping2 = asString(cell(row, columns.subgrouping2));
      const detectedCategory = asString(cell(row, columns.accountCategory));
      const detectedSide = asString(cell(row, columns.balanceSheetSide));
      const category = uniqueText([detectedCategory, subgrouping1, subgrouping2]).join(" | ");
      const side = uniqueText([detectedSide, grouping, subgrouping1]).join(" | ");
      const counterparty = asString(cell(row, columns.counterparty)) || undefined;
      const baseMapping = classifyAccount(glAccount, description, category, side);
      const mapping = applySavedMapping(baseMapping, savedMappings);
      const currency = columns.fixedCurrencyCode ?? extractCurrencyCode(cell(row, columns.currency)) ?? entity.currency;
      const period = asString(cell(row, columns.period));
      if (period) periods.push(period);

      const signals = [...mapping.signals];
      if (rawAmount < 0 && isAssetClass(mapping.accountingClass)) signals.push("Credit or contra-asset row; signed values are netted with related rows before the ratio is calculated.");
      if (counterparty) signals.push(`Counterparty/affiliate: ${counterparty}.`);
      if (columns.amountMode === "debit_credit") signals.push("Balance derived from separate debit and credit columns.");

      sheetLines.push({
        id: `${analysis.sheetName}:${rowIndex + 1}:${glAccount}`,
        sheetName: analysis.sheetName,
        rowNumber: rowIndex + 1,
        entityId: entity.id,
        entityName: entity.name,
        glAccount,
        description,
        rawBalance: rawAmount,
        value: rawAmount,
        currency,
        accountCategory: category || undefined,
        balanceSheetSide: side || undefined,
        counterparty,
        accountingClass: mapping.accountingClass,
        taxClassification: mapping.taxClassification,
        confidence: mapping.confidence,
        signals,
        sourceClassification: mapping.source,
        isAsset: isAssetClass(mapping.accountingClass),
        unresolved: mapping.taxClassification === "manual_review" || mapping.taxClassification === "potential_free_investment" || mapping.confidence < 0.65,
      });
    }

    if (unresolvedEntityRows.length) {
      const examples = unresolvedEntityRows.slice(0, 5).map((item) => `row ${item.rowNumber} (GL ${item.glAccount})`).join(", ");
      errors.push(`${analysis.sheetName}: could not determine the entity for ${unresolvedEntityRows.length} trial-balance row(s). Examples: ${examples}.`);
    }

    const nonZeroAssetLines = sheetLines.filter((line) => line.isAsset && Math.abs(line.rawBalance) > 0.000001);
    const netAssetAmount = nonZeroAssetLines.reduce((sum, line) => sum + line.rawBalance, 0);
    const negativeShare = nonZeroAssetLines.length ? nonZeroAssetLines.filter((line) => line.rawBalance < 0).length / nonZeroAssetLines.length : 0;
    const multiplier = netAssetAmount < 0 && negativeShare >= 0.7 ? -1 : 1;
    if (multiplier === -1) warnings.push(`${analysis.sheetName}: asset balances appear to use a credit-negative convention; signs were normalised.`);
    for (const line of sheetLines) line.value = line.rawBalance * multiplier;

    allLines.push(...sheetLines);
  }

  const negativeAssetGroups = new Map<string, { label: string; amount: number; currency?: string }>();
  for (const line of allLines.filter((candidate) => candidate.isAsset)) {
    const label = line.accountCategory || line.accountingClass.replaceAll("_", " ");
    const key = `${normalizeKey(line.entityId)}|${normalizeKey(label)}`;
    const current = negativeAssetGroups.get(key) ?? { label: `${line.entityName} - ${label}`, amount: 0, currency: line.currency };
    current.amount += line.value;
    negativeAssetGroups.set(key, current);
  }
  for (const group of negativeAssetGroups.values()) {
    if (group.amount < -0.01) warnings.push(`${group.label} has a negative net asset balance (${group.amount.toLocaleString("en-GB")} ${group.currency ?? ""}). Review whether this is a contra-asset, reclassification or source-data issue.`);
  }

  return { lines: allLines, periods };
}

function parseFairValues(sheets: AnalysedSheet[], entities: EntityRecord[]): FairValueAdjustment[] {
  const result: FairValueAdjustment[] = [];
  for (const { analysis, rows, dataEndRow } of sheets) {
    if (!analysis.headerRow) continue;
    const map = fieldMap(analysis);
    const fallback = inferEntityFromContext(analysis.sheetName, rows, analysis, entities);
    const endRow = dataEndRow ?? rows.length;
    for (let rowIndex = dataStartRowIndex(analysis); rowIndex < endRow; rowIndex += 1) {
      const row = rows[rowIndex];
      const glAccount = asString(cell(row, map.glAccount));
      const fairValue = parseNumber(cell(row, map.fairValue));
      const entityRaw = asString(cell(row, map.entityId)) || asString(cell(row, map.entityName));
      const entityKey = entityRaw ? normalizeKey(entityRaw) : fallback ? normalizeKey(fallback.id) : "";
      if (glAccount && fairValue !== null && entityKey) result.push({ entityKey, glAccount, fairValue });
    }
  }
  return result;
}

function parseTaxData(sheets: AnalysedSheet[]): EntityTaxData[] {
  const result: EntityTaxData[] = [];
  for (const { analysis, rows, dataEndRow } of sheets) {
    if (!analysis.headerRow) continue;
    const map = fieldMap(analysis);
    const endRow = dataEndRow ?? rows.length;
    for (let rowIndex = dataStartRowIndex(analysis); rowIndex < endRow; rowIndex += 1) {
      const row = rows[rowIndex];
      const entityRaw = asString(cell(row, map.entityId)) || asString(cell(row, map.entityName));
      if (!entityRaw) continue;
      const taxRate = parsePercentage(cell(row, map.taxRate));
      const motiveTest = parseTestState(cell(row, map.motiveTest));
      const subjectToTaxTest = parseTestState(cell(row, map.subjectToTaxTest));
      result.push({ entityKey: normalizeKey(entityRaw), taxRate: taxRate ?? undefined, motiveTest, subjectToTaxTest });
    }
  }
  return result;
}

function applyFairValues(lines: TrialBalanceLine[], adjustments: FairValueAdjustment[]): void {
  for (const adjustment of adjustments) {
    const matching = lines.filter((line) => {
      const entityMatch = normalizeKey(line.entityId) === adjustment.entityKey || normalizeKey(line.entityName) === adjustment.entityKey;
      return entityMatch && normalizeKey(line.glAccount) === normalizeKey(adjustment.glAccount);
    });
    if (!matching.length) continue;
    const bookValue = matching.reduce((sum, line) => sum + line.value, 0);
    const delta = adjustment.fairValue - bookValue;
    matching[0].value += delta;
    matching[0].signals = [...matching[0].signals, `Fair-value adjustment applied to the net GL balance: ${bookValue} -> ${adjustment.fairValue}.`];
  }
}

function makeTableRegions(sheetRows: WorkbookSheetRows[]): { summaries: AnalysedSheet[]; tables: AnalysedSheet[] } {
  const summaries: AnalysedSheet[] = [];
  const tables: AnalysedSheet[] = [];

  for (const { sheetName, rows } of sheetRows) {
    const summary: AnalysedSheet = { rows, analysis: analyseSheet(sheetName, rows) };
    summaries.push(summary);

    const analyses = analyseSheetTables(sheetName, rows)
      .filter((analysis) => analysis.headerRow !== null)
      .sort((first, second) => (first.headerRow ?? 0) - (second.headerRow ?? 0));
    for (let index = 0; index < analyses.length; index += 1) {
      const nextHeader = analyses[index + 1]?.headerRow;
      tables.push({
        rows,
        analysis: analyses[index],
        dataEndRow: nextHeader ? Math.max(dataStartRowIndex(analyses[index]), nextHeader - 1) : rows.length,
      });
    }
  }
  summaries.forEach(updateTrialAnalysisFields);
  tables.forEach(updateTrialAnalysisFields);
  return { summaries, tables };
}

function analyseCurrencies(
  lines: TrialBalanceLine[],
  entities: EntityRecord[],
  analysisMode: ImportResult["analysisMode"],
  errors: string[],
  warnings: string[],
): string | undefined {
  const assetLines = lines.filter((line) => line.isAsset);
  for (const entity of entities) {
    const entityLines = assetLines.filter((line) => line.entityId === entity.id);
    for (const line of entityLines) line.currency ??= entity.currency;
    const currencies = new Set(entityLines.map((line) => line.currency).filter((value): value is string => Boolean(value)));
    if (currencies.size === 1) {
      entity.currency = [...currencies][0];
      for (const line of entityLines) line.currency ??= entity.currency;
    } else if (currencies.size > 1) {
      errors.push(`${entity.name}: multiple currencies were detected (${[...currencies].sort().join(", ")}). Select a common reporting/base-currency amount column before calculating this entity.`);
    }
  }

  const globalCurrencies = new Set(assetLines.map((line) => line.currency).filter((value): value is string => Boolean(value)));
  if (globalCurrencies.size === 1) {
    const reportingCurrency = [...globalCurrencies][0];
    for (const line of assetLines) line.currency ??= reportingCurrency;
    for (const entity of entities) entity.currency ??= reportingCurrency;
    return reportingCurrency;
  }
  if (globalCurrencies.size > 1) {
    if (analysisMode === "group_structure") {
      errors.push(`Multiple currencies were detected across the ownership structure (${[...globalCurrencies].sort().join(", ")}). A common reporting-currency amount is required before values can be attributed and combined.`);
    } else {
      const unresolved = entities.filter((entity) => {
        const entityCurrencies = new Set(assetLines.filter((line) => line.entityId === entity.id).map((line) => line.currency).filter(Boolean));
        return entityCurrencies.size !== 1;
      });
      if (!unresolved.length) warnings.push(`Standalone entities use different currencies (${[...globalCurrencies].sort().join(", ")}). They will be calculated separately and will not be combined.`);
    }
    return undefined;
  }
  if (assetLines.length) warnings.push("No reporting currency could be determined. The calculation can run, but amounts will be displayed without a currency label.");
  return undefined;
}

export function parseWorkbookRows(
  fileName: string,
  fileSize: number,
  sheetRows: WorkbookSheetRows[],
  savedMappings: Record<string, AccountMapping> = {},
): ImportResult {
  const { summaries, tables } = makeTableRegions(sheetRows);

  const errors: string[] = [];
  const warnings: string[] = [];
  const messages = tables.length ? tables : summaries;
  for (const sheet of messages) {
    const location = sheet.analysis.headerRow ? `${sheet.analysis.sheetName} row ${sheet.analysis.headerRow}` : sheet.analysis.sheetName;
    errors.push(...sheet.analysis.errors.map((error) => `${location}: ${error}`));
    warnings.push(...sheet.analysis.warnings.map((warning) => `${location}: ${warning}`));
  }
  for (const sheet of summaries) {
    warnings.push(...sheet.analysis.warnings.filter((warning) => warning.includes("structured table block")).map((warning) => `${sheet.analysis.sheetName}: ${warning}`));
  }

  const structureSheets = tables.filter((sheet) => sheet.analysis.role === "structure");
  const structureDetected = structureSheets.length > 0;
  let entities = buildEntities(structureSheets, errors, warnings);

  const trialSheets = tables.filter((sheet) => sheet.analysis.role === "trial_balance");
  if (!trialSheets.length) errors.push("No trial-balance table could be identified. A row-based table with a GL account and balance, or debit and credit, is required.");

  if (!entities.length && trialSheets.length) entities = inferEntitiesFromTrialSheets(trialSheets, summaries);
  const analysisMode: ImportResult["analysisMode"] = structureDetected ? "group_structure" : "standalone_entities";
  if (!structureDetected && entities.length) {
    const entityCountText = entities.length === 1 ? "1 entity was" : `${entities.length} entities were`;
    warnings.push(`No group-structure table was found. ${entityCountText} inferred from trial-balance fields, sheet titles or workbook context. Entity-level asset analysis can run, but ownership and the 5% participation test remain not assessed.`);
  }
  if (!entities.length) errors.push("No entity could be determined from a structure table, trial-balance entity field, sheet title or workbook title.");

  const { lines, periods } = parseTrialBalanceLines(trialSheets, entities, savedMappings, errors, warnings);
  if (!lines.length) errors.push("No usable trial-balance lines were extracted.");

  const fairValueAdjustments = parseFairValues(tables.filter((sheet) => sheet.analysis.role === "fair_value"), entities);
  applyFairValues(lines, fairValueAdjustments);
  const taxData = parseTaxData(tables.filter((sheet) => sheet.analysis.role === "tax_master"));
  const reportingCurrency = analyseCurrencies(lines, entities, analysisMode, errors, warnings);

  return {
    fileName,
    fileSize,
    sheets: summaries.map((sheet) => sheet.analysis),
    entities,
    lines,
    fairValueAdjustments,
    taxData,
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
    period: inferPeriod(fileName, periods, summaries),
    reportingCurrency,
    analysisMode,
    structureDetected,
  };
}

export async function parseWorkbook(file: File, savedMappings: Record<string, AccountMapping> = {}): Promise<ImportResult> {
  const XLSX = await import("xlsx");
  const data = await file.arrayBuffer();
  const workbook = XLSX.read(data, { dense: true, cellDates: true });
  const sheetRows = workbook.SheetNames.map((sheetName) => ({ sheetName, rows: getRows(XLSX, workbook, sheetName) }));
  return parseWorkbookRows(file.name, file.size, sheetRows, savedMappings);
}

export function aggregateMappings(lines: TrialBalanceLine[]): AccountMapping[] {
  const map = new Map<string, AccountMapping>();
  for (const line of lines) {
    const key = mappingKey(line.glAccount, line.description);
    if (!map.has(key)) {
      map.set(key, {
        key,
        glAccount: line.glAccount,
        description: line.description,
        accountingClass: line.accountingClass,
        taxClassification: line.taxClassification,
        confidence: line.confidence,
        signals: line.signals,
        source: line.sourceClassification,
      });
    }
  }
  return [...map.values()].sort((first, second) => first.glAccount.localeCompare(second.glAccount, undefined, { numeric: true }));
}
