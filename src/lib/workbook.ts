import { classifyAccount, isAssetClass, mappingKey } from "./classification";
import { analyseSheet, fieldMap } from "./fieldDetection";
import { normalizeKey, normalizeText, parseNumber, parsePercentage, similarity, slug } from "./text";
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
}

interface TrialColumns {
  entityId?: number;
  entityName?: number;
  glAccount?: number;
  glDescription?: number;
  balance?: number;
  currency?: number;
  period?: number;
  accountCategory?: number;
  balanceSheetSide?: number;
  grouping?: number;
  subgrouping1?: number;
  subgrouping2?: number;
  counterparty?: number;
  selectionNote?: string;
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
  return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
    header: 1,
    defval: "",
    raw: true,
    blankrows: true,
  }) as unknown[][];
}

function headerValues(rows: unknown[][], analysis: SheetAnalysis): string[] {
  if (!analysis.headerRow) return [];
  return (rows[analysis.headerRow - 1] ?? []).map(asString);
}

function findHeaderIndex(headers: string[], aliases: string[]): number | undefined {
  const normalizedAliases = aliases.map(normalizeText);
  const exact = headers.findIndex((header) => normalizedAliases.includes(normalizeText(header)));
  if (exact >= 0) return exact;
  const contained = headers.findIndex((header) => normalizedAliases.some((alias) => normalizeText(header).includes(alias)));
  return contained >= 0 ? contained : undefined;
}

function numericRatio(rows: unknown[][], headerRow: number, columnIndex: number): number {
  const sample = rows.slice(headerRow, headerRow + 50).map((row) => cell(row, columnIndex)).filter((value) => asString(value) !== "");
  if (!sample.length) return 0;
  return sample.filter((value) => parseNumber(value) !== null).length / sample.length;
}

function resolveTrialColumns(rows: unknown[][], analysis: SheetAnalysis): TrialColumns {
  const map = fieldMap(analysis);
  const headers = headerValues(rows, analysis);
  const headerRow = analysis.headerRow ?? 1;

  const baseCurrency = findHeaderIndex(headers, ["base currency", "reporting currency", "functional currency", "group currency"]);
  const amountCandidates = headers
    .map((header, columnIndex) => ({ header, columnIndex, normalized: normalizeText(header), numeric: numericRatio(rows, headerRow, columnIndex) }))
    .filter((candidate) => candidate.numeric >= 0.7)
    .filter((candidate) => /(amount|balance|saldo)/.test(candidate.normalized));

  let reportingAmount: number | undefined;
  if (baseCurrency !== undefined) {
    reportingAmount = amountCandidates
      .map((candidate) => {
        let score = 0;
        if (["sum amount", "base amount", "reporting amount", "functional amount", "group amount", "closing balance", "ending balance"].includes(candidate.normalized)) score += 8;
        if (candidate.normalized.includes("transaction") || candidate.normalized.includes("document")) score -= 10;
        const distance = candidate.columnIndex - baseCurrency;
        if (distance === 1) score += 10;
        else if (distance > 0 && distance <= 3) score += 5 - distance;
        score += candidate.numeric;
        return { ...candidate, score };
      })
      .sort((first, second) => second.score - first.score)[0]?.columnIndex;
  }

  const entityId = map.entityId ?? findHeaderIndex(headers, ["bu", "business unit", "business unit code", "entity id", "entity code", "company code"]);
  const entityName = map.entityName ?? findHeaderIndex(headers, ["entity", "entity name", "company", "company name", "legal entity"]);
  const grouping = findHeaderIndex(headers, ["grouping", "statement type", "financial statement"]);
  const subgrouping1 = findHeaderIndex(headers, ["subgrouping1", "subgrouping 1", "sub grouping 1", "account group"]);
  const subgrouping2 = findHeaderIndex(headers, ["subgrouping2", "subgrouping 2", "sub grouping 2", "account subgroup"]);
  const counterparty = findHeaderIndex(headers, ["affl", "affiliate", "affiliate code", "counterparty", "related party", "intercompany partner"]);

  const balance = reportingAmount ?? map.balance;
  const currency = baseCurrency ?? map.currency;
  const selectionNote = reportingAmount !== undefined && baseCurrency !== undefined
    ? `Using '${headers[reportingAmount]}' with '${headers[baseCurrency]}' as the common reporting-currency balance.`
    : undefined;

  return {
    entityId,
    entityName,
    glAccount: map.glAccount,
    glDescription: map.glDescription,
    balance,
    currency,
    period: map.period,
    accountCategory: map.accountCategory,
    balanceSheetSide: map.balanceSheetSide,
    grouping,
    subgrouping1,
    subgrouping2,
    counterparty,
    selectionNote,
  };
}

function updateTrialAnalysisFields(sheet: AnalysedSheet): void {
  if (sheet.analysis.role !== "trial_balance" || !sheet.analysis.headerRow) return;
  const columns = resolveTrialColumns(sheet.rows, sheet.analysis);
  const headers = headerValues(sheet.rows, sheet.analysis);
  const updates: Array<{ field: "entityId" | "balance" | "currency" | "accountCategory" | "balanceSheetSide"; index: number | undefined }> = [
    { field: "entityId", index: columns.entityId },
    { field: "balance", index: columns.balance },
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
  if (columns.selectionNote && !sheet.analysis.warnings.includes(columns.selectionNote)) sheet.analysis.warnings.push(columns.selectionNote);
  sheet.analysis.confidence = sheet.analysis.fields.reduce((sum, field) => sum + field.confidence, 0) / sheet.analysis.fields.length;
}

function inferEntityFromContext(sheetName: string, rows: unknown[][], analysis: SheetAnalysis, entities: EntityRecord[]): EntityRecord | null {
  if (entities.length === 1) return entities[0];
  if (!entities.length) return null;
  const preHeaderRows = analysis.headerRow ? rows.slice(0, Math.max(0, analysis.headerRow - 1)) : rows.slice(0, 10);
  const context = [sheetName, ...preHeaderRows.flat().map(asString).filter(Boolean)].join(" ");
  const ranked = entities
    .map((entity) => ({ entity, score: Math.max(similarity(sheetName, entity.name), similarity(context, entity.name), similarity(context, entity.id)) }))
    .sort((first, second) => second.score - first.score);
  if (!ranked[0] || ranked[0].score < 0.56) return null;
  if (ranked[1] && ranked[0].score - ranked[1].score < 0.06) return null;
  return ranked[0].entity;
}

function buildEntities(structureSheets: AnalysedSheet[], errors: string[], warnings: string[]): EntityRecord[] {
  const raw: Array<EntityRecord & { parentRaw?: string }> = [];

  for (const { analysis, rows } of structureSheets) {
    if (!analysis.headerRow) continue;
    const map = fieldMap(analysis);
    for (let rowIndex = analysis.headerRow; rowIndex < rows.length; rowIndex += 1) {
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
        currency: asString(cell(row, map.currency)).toUpperCase() || undefined,
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
    sheets.flatMap(({ rows }) => rows.slice(0, 12).flatMap((row) => row.slice(0, 10))).filter((value) => typeof value === "string"),
  );
}

function bestNameForEntityId(entityId: string, sheets: AnalysedSheet[]): string | undefined {
  const candidates = workbookContextStrings(sheets);
  const escaped = escapeRegExp(entityId);
  const idPattern = new RegExp(`^\\s*${escaped}\\s*[-:|]\\s*(.+)$`, "i");
  const generic = /\b(statement|trial balance|balance sheet|period|year ended|as at|test)\b/i;
  const legal = /\b(limited|ltd|b\.v\.|bv|n\.v\.|nv|gmbh|s\.a\.|sa|sarl|sas|inc|llc|plc|company|corporation)\b/i;

  return candidates
    .map((candidate) => {
      const match = candidate.match(idPattern);
      const name = match?.[1]?.trim() || candidate.trim();
      let score = 0;
      if (normalizeKey(candidate).includes(normalizeKey(entityId))) score += 8;
      if (match) score += 7;
      if (legal.test(name)) score += 5;
      if (name.length >= 12 && name.length <= 120) score += 2;
      if (generic.test(name)) score -= 8;
      return { name, score };
    })
    .filter((candidate) => candidate.score >= 7 && normalizeKey(candidate.name) !== normalizeKey(entityId))
    .sort((first, second) => second.score - first.score || second.name.length - first.name.length)[0]?.name;
}

function inferEntitiesFromTrialSheets(trialSheets: AnalysedSheet[], allSheets: AnalysedSheet[]): EntityRecord[] {
  const inferred = new Map<string, { id: string; name?: string; currency?: string }>();

  for (const sheet of trialSheets) {
    if (!sheet.analysis.headerRow) continue;
    const columns = resolveTrialColumns(sheet.rows, sheet.analysis);
    for (let rowIndex = sheet.analysis.headerRow; rowIndex < sheet.rows.length; rowIndex += 1) {
      const row = sheet.rows[rowIndex];
      const idRaw = asString(cell(row, columns.entityId));
      const nameRaw = asString(cell(row, columns.entityName));
      if (!idRaw && !nameRaw) continue;
      const id = idRaw || slug(nameRaw);
      const key = normalizeKey(id);
      if (!key) continue;
      const existing = inferred.get(key);
      const currency = asString(cell(row, columns.currency)).toUpperCase() || undefined;
      inferred.set(key, {
        id,
        name: existing?.name || nameRaw || undefined,
        currency: existing?.currency || currency,
      });
    }
  }

  if (!inferred.size) {
    const contexts = workbookContextStrings(allSheets);
    for (const context of contexts) {
      const match = context.match(/^\s*([A-Za-z][A-Za-z0-9._/-]{1,20})\s*[-:|]\s*(.{4,120})$/);
      if (!match) continue;
      const id = match[1].trim();
      const name = match[2].trim();
      if (/\b(statement|period|year ended|test)\b/i.test(name)) continue;
      inferred.set(normalizeKey(id), { id, name });
      break;
    }
  }

  return [...inferred.values()].map((entity) => ({
    id: entity.id,
    name: entity.name || bestNameForEntityId(entity.id, allSheets) || entity.id,
    parentId: null,
    parentName: null,
    ownershipPct: 100,
    ownershipProvided: false,
    source: entity.name ? "trial_balance" : bestNameForEntityId(entity.id, allSheets) ? "workbook_context" : "trial_balance",
    currency: entity.currency,
  }));
}

function applySavedMapping(base: AccountMapping, savedMappings: Record<string, AccountMapping>): AccountMapping {
  const saved = savedMappings[base.key];
  return saved ? { ...saved, source: "saved_mapping" } : base;
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

  for (const { analysis, rows } of trialSheets) {
    if (!analysis.headerRow) continue;
    const columns = resolveTrialColumns(rows, analysis);
    const fallbackEntity = inferEntityFromContext(analysis.sheetName, rows, analysis, entities);
    const balanceHeader = headerValues(rows, analysis)[columns.balance ?? -1] ?? "";
    const headerCurrencyMatch = balanceHeader.match(/\b(EUR|USD|GBP|HKD|CHF|JPY|AUD|CAD|CNY)\b/i);
    const headerCurrency = headerCurrencyMatch?.[1]?.toUpperCase();
    const sheetLines: TrialBalanceLine[] = [];
    const unresolvedEntityRows: Array<{ rowNumber: number; glAccount: string }> = [];

    for (let rowIndex = analysis.headerRow; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      const glAccount = asString(cell(row, columns.glAccount));
      const rawAmount = parseNumber(cell(row, columns.balance));
      if (!glAccount && rawAmount === null) continue;
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
      const currency = headerCurrency || asString(cell(row, columns.currency)).toUpperCase() || entity.currency;
      const period = asString(cell(row, columns.period));
      if (period) periods.push(period);

      const signals = [...mapping.signals];
      if (rawAmount < 0 && isAssetClass(mapping.accountingClass)) signals.push("Credit or contra-asset row; signed values are netted with related rows before the ratio is calculated.");
      if (counterparty) signals.push(`Counterparty/affiliate: ${counterparty}.`);

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
  for (const { analysis, rows } of sheets) {
    if (!analysis.headerRow) continue;
    const map = fieldMap(analysis);
    const fallback = inferEntityFromContext(analysis.sheetName, rows, analysis, entities);
    for (let rowIndex = analysis.headerRow; rowIndex < rows.length; rowIndex += 1) {
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
  for (const { analysis, rows } of sheets) {
    if (!analysis.headerRow) continue;
    const map = fieldMap(analysis);
    for (let rowIndex = analysis.headerRow; rowIndex < rows.length; rowIndex += 1) {
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

export function parseWorkbookRows(
  fileName: string,
  fileSize: number,
  sheetRows: WorkbookSheetRows[],
  savedMappings: Record<string, AccountMapping> = {},
): ImportResult {
  const sheets: AnalysedSheet[] = sheetRows.map(({ sheetName, rows }) => ({ rows, analysis: analyseSheet(sheetName, rows) }));
  sheets.forEach(updateTrialAnalysisFields);

  const errors: string[] = [];
  const warnings: string[] = [];
  for (const sheet of sheets) {
    errors.push(...sheet.analysis.errors.map((error) => `${sheet.analysis.sheetName}: ${error}`));
    warnings.push(...sheet.analysis.warnings.map((warning) => `${sheet.analysis.sheetName}: ${warning}`));
  }

  const structureSheets = sheets.filter((sheet) => sheet.analysis.role === "structure");
  const structureDetected = structureSheets.length > 0;
  let entities = buildEntities(structureSheets, errors, warnings);

  const trialSheets = sheets.filter((sheet) => sheet.analysis.role === "trial_balance");
  if (!trialSheets.length) errors.push("No trial-balance sheet could be identified. A sheet with GL account and balance fields is required.");

  if (!entities.length && trialSheets.length) entities = inferEntitiesFromTrialSheets(trialSheets, sheets);
  const analysisMode = structureDetected ? "group_structure" : "standalone_entities";
  if (!structureDetected && entities.length) {
    warnings.push(`No group-structure table was found. ${entities.length} entity${entities.length === 1 ? " was" : "ies were"} inferred from the trial balance and workbook context. Entity-level asset analysis can run, but ownership and the 5% participation test remain not assessed.`);
  }
  if (!entities.length) errors.push("No entity could be determined from a structure table, trial-balance entity field or workbook title.");

  const { lines, periods } = parseTrialBalanceLines(trialSheets, entities, savedMappings, errors, warnings);
  if (!lines.length) errors.push("No usable trial-balance lines were extracted.");

  const fairValueAdjustments = parseFairValues(sheets.filter((sheet) => sheet.analysis.role === "fair_value"), entities);
  applyFairValues(lines, fairValueAdjustments);
  const taxData = parseTaxData(sheets.filter((sheet) => sheet.analysis.role === "tax_master"));

  const currencies = new Set(lines.filter((line) => line.isAsset && line.currency).map((line) => line.currency!.toUpperCase()));
  let reportingCurrency: string | undefined;
  if (currencies.size === 1) reportingCurrency = [...currencies][0];
  else if (currencies.size > 1) {
    errors.push(`Multiple currencies were detected (${[...currencies].join(", ")}). The tool will not combine them without a common reporting-currency amount column.`);
  }

  return {
    fileName,
    fileSize,
    sheets: sheets.map((sheet) => sheet.analysis),
    entities,
    lines,
    fairValueAdjustments,
    taxData,
    errors,
    warnings,
    period: inferPeriod(fileName, periods, sheets),
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
