import type {
  CalculationContribution,
  CalculationResult,
  EntityCalculation,
  EntityRecord,
  EntityTaxData,
  ImportResult,
  TestState,
  TrialBalanceLine,
} from "./types";
import { normalizeKey } from "./text";

interface Aggregate {
  denominator: number;
  confirmedLowTaxed: number;
  potential: number;
  review: number;
  unresolvedCount: number;
  contributions: CalculationContribution[];
  warnings: string[];
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function findTaxData(entity: EntityRecord, taxData: EntityTaxData[]): EntityTaxData | undefined {
  const id = normalizeKey(entity.id);
  const name = normalizeKey(entity.name);
  return taxData.find((item) => item.entityKey === id || item.entityKey === name);
}

function ownAggregate(entity: EntityRecord, lines: TrialBalanceLine[], path: string[]): Aggregate {
  const entityLines = lines.filter((line) => line.entityId === entity.id && line.isAsset);
  const contributions: CalculationContribution[] = [];
  const warnings: string[] = [];
  let denominator = 0;
  let confirmedLowTaxed = 0;
  let potential = 0;
  let review = 0;
  let unresolvedCount = 0;

  for (const line of entityLines) {
    const value = finite(line.value);
    const excluded = line.taxClassification === "not_relevant" || line.taxClassification === "excluded_specific_rule";
    if (excluded) {
      contributions.push({
        sourceEntityId: entity.id,
        sourceEntityName: entity.name,
        sheetName: line.sheetName,
        rowNumber: line.rowNumber,
        glAccount: line.glAccount,
        description: line.description,
        sourceValue: line.value,
        ownershipFactor: 1,
        attributedValue: 0,
        taxClassification: line.taxClassification,
        accountingClass: line.accountingClass,
        includedInDenominator: false,
        includedInNumerator: false,
        includedInPotential: false,
        path,
        ruleNotes: line.signals,
      });
      continue;
    }

    // Signed values are intentionally retained. This nets clearing entries,
    // accumulated depreciation and FX rows instead of grossing up assets.
    denominator += value;
    if (line.taxClassification === "low_taxed_free_investment") confirmedLowTaxed += value;
    else if (line.taxClassification === "potential_free_investment") potential += value;
    else if (line.taxClassification === "manual_review") review += value;
    if (line.unresolved) unresolvedCount += 1;

    contributions.push({
      sourceEntityId: entity.id,
      sourceEntityName: entity.name,
      sheetName: line.sheetName,
      rowNumber: line.rowNumber,
      glAccount: line.glAccount,
      description: line.description,
      sourceValue: line.value,
      ownershipFactor: 1,
      attributedValue: value,
      taxClassification: line.taxClassification,
      accountingClass: line.accountingClass,
      includedInDenominator: true,
      includedInNumerator: line.taxClassification === "low_taxed_free_investment",
      includedInPotential: ["potential_free_investment", "manual_review"].includes(line.taxClassification),
      path,
      ruleNotes: line.signals,
    });
  }

  if (denominator < 0) {
    warnings.push(`${entity.name}: the net relevant-asset balance is negative. The denominator was set to zero and the source data requires review.`);
    denominator = 0;
  }
  confirmedLowTaxed = Math.max(0, confirmedLowTaxed);
  potential = Math.max(0, potential);
  review = Math.max(0, review);

  // Point-in-time implementation of the 30/70 entity filter.
  // It is only auto-applied when no unresolved or potential amount exists.
  const resolvedRatio = denominator > 0 ? confirmedLowTaxed / denominator : 0;
  const canApplyThirtySeventy = denominator > 0 && unresolvedCount === 0 && potential === 0 && review === 0 && resolvedRatio <= 0.3;
  if (canApplyThirtySeventy && confirmedLowTaxed > 0) {
    for (const contribution of contributions) {
      if (contribution.includedInNumerator) {
        contribution.includedInNumerator = false;
        contribution.ruleNotes = [
          ...contribution.ruleNotes,
          "30/70 entity-level filter applied on the current snapshot: low-taxed free investments are <=30% of this entity's relevant non-participation assets.",
        ];
      }
    }
    confirmedLowTaxed = 0;
  }

  return { denominator, confirmedLowTaxed, potential, review, unresolvedCount, contributions, warnings };
}

function scaleAggregate(aggregate: Aggregate, factor: number, path: string[]): Aggregate {
  return {
    denominator: aggregate.denominator * factor,
    confirmedLowTaxed: aggregate.confirmedLowTaxed * factor,
    potential: aggregate.potential * factor,
    review: aggregate.review * factor,
    unresolvedCount: aggregate.unresolvedCount,
    warnings: aggregate.warnings,
    contributions: aggregate.contributions.map((contribution) => ({
      ...contribution,
      ownershipFactor: contribution.ownershipFactor * factor,
      attributedValue: contribution.attributedValue * factor,
      path,
    })),
  };
}

function combine(first: Aggregate, second: Aggregate): Aggregate {
  return {
    denominator: first.denominator + second.denominator,
    confirmedLowTaxed: first.confirmedLowTaxed + second.confirmedLowTaxed,
    potential: first.potential + second.potential,
    review: first.review + second.review,
    unresolvedCount: first.unresolvedCount + second.unresolvedCount,
    contributions: [...first.contributions, ...second.contributions],
    warnings: [...first.warnings, ...second.warnings],
  };
}

function aggregateGroup(
  entity: EntityRecord,
  entities: EntityRecord[],
  lines: TrialBalanceLine[],
  path: string[],
  recursion: Set<string>,
): Aggregate {
  if (recursion.has(entity.id)) throw new Error(`Circular ownership encountered during calculation at ${entity.name}.`);
  const nextRecursion = new Set(recursion);
  nextRecursion.add(entity.id);
  const currentPath = [...path, entity.name];
  let total = ownAggregate(entity, lines, currentPath);
  const children = entities.filter((candidate) => candidate.parentId === entity.id);
  for (const child of children) {
    const childAggregate = aggregateGroup(child, entities, lines, currentPath, nextRecursion);
    total = combine(total, scaleAggregate(childAggregate, child.ownershipPct / 100, [...currentPath, child.name]));
  }
  return total;
}

function statusFromRatio(confirmedRatio: number, upperBoundRatio: number, unresolvedCount: number): EntityCalculation["status"] {
  if (confirmedRatio >= 0.5) return "TAX_REVIEW_REQUIRED";
  if (unresolvedCount > 0 || (upperBoundRatio >= 0.5 && confirmedRatio < 0.5)) return "REVIEW_REQUIRED";
  if (confirmedRatio >= 0.45) return "HIGH_ATTENTION";
  if (confirmedRatio >= 0.4) return "ATTENTION";
  return "NORMAL";
}

function testFromRatio(confirmedRatio: number, upperBoundRatio: number, unresolvedCount: number): TestState {
  if (confirmedRatio >= 0.5) return "FAIL";
  if (unresolvedCount > 0 || upperBoundRatio >= 0.5) return "REVIEW";
  return "PASS";
}

function overallAssessment(participation: TestState, motive: TestState, subjectToTax: TestState, asset: TestState): EntityCalculation["overall"] {
  if (participation === "FAIL") return "NOT_APPLICABLE";
  if (participation === "REVIEW" || participation === "NOT_ASSESSED") return "REVIEW_REQUIRED";
  if (motive === "PASS" || subjectToTax === "PASS" || asset === "PASS") return "LIKELY_QUALIFIES";
  if (motive === "FAIL" && subjectToTax === "FAIL" && asset === "FAIL") return "AT_RISK";
  return "REVIEW_REQUIRED";
}

function calculationTargets(importResult: ImportResult, warnings: string[]): EntityRecord[] {
  const roots = importResult.entities.filter((entity) => !entity.parentId);
  if (importResult.analysisMode === "standalone_entities") {
    return roots.filter((entity) => importResult.lines.some((line) => line.entityId === entity.id));
  }

  const rootIds = new Set(roots.map((root) => root.id));
  const directParticipations = importResult.entities.filter((entity) => entity.parentId && rootIds.has(entity.parentId));
  if (!directParticipations.length) warnings.push("No direct participations were found below the detected top entity/entities.");
  return directParticipations;
}

export function calculate(importResult: ImportResult): CalculationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (importResult.errors.length) {
    return { calculations: [], errors: ["Resolve import errors before calculating."], warnings: importResult.warnings };
  }

  const roots = importResult.entities.filter((entity) => !entity.parentId);
  if (!roots.length) return { calculations: [], errors: ["No root/top entity was found."], warnings };

  const targets = calculationTargets(importResult, warnings);
  if (!targets.length) return { calculations: [], errors: ["No entity with usable trial-balance data was available for calculation."], warnings };

  const calculations: EntityCalculation[] = [];
  for (const target of targets) {
    try {
      const aggregate = aggregateGroup(target, importResult.entities, importResult.lines, [], new Set());
      warnings.push(...aggregate.warnings);
      const denominator = aggregate.denominator;
      const confirmedRatio = denominator > 0 ? aggregate.confirmedLowTaxed / denominator : 0;
      const upperBoundRatio = denominator > 0
        ? Math.min(1, Math.max(0, (aggregate.confirmedLowTaxed + aggregate.potential + aggregate.review) / denominator))
        : 0;
      const participationTest: TestState = target.ownershipProvided ? (target.ownershipPct >= 5 ? "PASS" : "FAIL") : "NOT_ASSESSED";
      const tax = findTaxData(target, importResult.taxData);
      const motiveTest = tax?.motiveTest ?? "NOT_ASSESSED";
      // A tax rate of >=10% is only a signal. It does not auto-pass because the tax base must also be assessed.
      const subjectToTaxTest = tax?.subjectToTaxTest ?? (tax?.taxRate !== undefined ? "REVIEW" : "NOT_ASSESSED");
      const assetTest = testFromRatio(confirmedRatio, upperBoundRatio, aggregate.unresolvedCount);
      const thirtySeventyApplied = aggregate.contributions.some((contribution) => contribution.ruleNotes.some((note) => note.startsWith("30/70 entity-level")));

      calculations.push({
        entityId: target.id,
        entityName: target.name,
        directOwnershipPct: target.ownershipPct,
        ownershipProvided: target.ownershipProvided,
        analysisMode: importResult.analysisMode,
        totalRelevantAssets: denominator,
        confirmedLowTaxed: aggregate.confirmedLowTaxed,
        potentialFreeInvestments: aggregate.potential,
        unresolvedReview: aggregate.review,
        confirmedRatio,
        upperBoundRatio,
        thirtySeventyApplied,
        participationTest,
        motiveTest,
        subjectToTaxTest,
        assetTest,
        overall: overallAssessment(participationTest, motiveTest, subjectToTaxTest, assetTest),
        status: statusFromRatio(confirmedRatio, upperBoundRatio, aggregate.unresolvedCount),
        contributions: aggregate.contributions.sort((first, second) => Math.abs(second.attributedValue) - Math.abs(first.attributedValue)),
      });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : `Calculation failed for ${target.name}.`);
    }
  }

  return { calculations, errors, warnings: [...new Set(warnings)] };
}

export function applyClassificationToLines(
  lines: TrialBalanceLine[],
  glAccount: string,
  description: string,
  classification: TrialBalanceLine["taxClassification"],
): TrialBalanceLine[] {
  const glKey = normalizeKey(glAccount);
  const descriptionKey = normalizeKey(description);
  return lines.map((line) => {
    if (normalizeKey(line.glAccount) !== glKey || normalizeKey(line.description) !== descriptionKey) return line;
    return {
      ...line,
      taxClassification: classification,
      isAsset: classification !== "not_relevant",
      unresolved: classification === "manual_review" || classification === "potential_free_investment",
      sourceClassification: "manual",
      confidence: 1,
      signals: [...line.signals, `Manual classification: ${classification}.`],
    };
  });
}
