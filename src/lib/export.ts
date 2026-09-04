import type { CalculationResult, ImportResult } from "./types";
import { aggregateMappings } from "./workbook";

export async function exportWorkbook(importResult: ImportResult, calculation: CalculationResult): Promise<void> {
  const XLSX = await import("xlsx");
  const workbook = XLSX.utils.book_new();

  const summary = calculation.calculations.map((item) => ({
    "Analysis mode": item.analysisMode === "group_structure" ? "Group participation analysis" : "Standalone entity asset analysis",
    "Entity / participation": item.entityName,
    "Direct ownership %": item.ownershipProvided ? item.directOwnershipPct : "Not provided",
    "Participation test": item.participationTest,
    "Motive test": item.motiveTest,
    "Subject-to-tax test": item.subjectToTaxTest,
    "Asset test": item.assetTest,
    "Confirmed low-tax %": item.confirmedRatio * 100,
    "Upper-bound %": item.upperBoundRatio * 100,
    "Relevant assets": item.totalRelevantAssets,
    "Confirmed low-taxed free investments": item.confirmedLowTaxed,
    "Potential free investments": item.potentialFreeInvestments,
    "Manual review amount": item.unresolvedReview,
    Status: item.status,
    "Overall assessment": item.overall,
    "30/70 filter applied": item.thirtySeventyApplied ? "Yes" : "No",
  }));
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(summary), "Summary");

  const recognition = importResult.sheets.map((sheet) => ({
    Sheet: sheet.sheetName,
    Role: sheet.role,
    "Header row": sheet.headerRow ?? "",
    "Rows detected": sheet.rowCount,
    "Columns detected": sheet.columnCount,
    "Recognition confidence %": Math.round(sheet.confidence * 100),
    Fields: sheet.fields.map((field) => `${field.header} -> ${field.field} (${Math.round(field.confidence * 100)}%)`).join("; "),
    Errors: sheet.errors.join("; "),
    Warnings: sheet.warnings.join("; "),
  }));
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(recognition), "Recognition");

  const entities = importResult.entities.map((entity) => ({
    "Entity ID": entity.id,
    "Entity name": entity.name,
    "Parent ID": entity.parentId ?? "",
    "Ownership %": entity.ownershipProvided ? entity.ownershipPct : "Not provided",
    Source: entity.source,
    Currency: entity.currency ?? "",
  }));
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(entities), "Entities");

  const mappings = aggregateMappings(importResult.lines).map((mapping) => ({
    "GL account": mapping.glAccount,
    Description: mapping.description,
    "Accounting class": mapping.accountingClass,
    "Tax classification": mapping.taxClassification,
    "Confidence %": Math.round(mapping.confidence * 100),
    Source: mapping.source,
    Signals: mapping.signals.join("; "),
  }));
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(mappings), "Account mapping");

  const details = calculation.calculations.flatMap((calculationItem) =>
    calculationItem.contributions.map((detail) => ({
      "Entity / participation": calculationItem.entityName,
      "Source entity": detail.sourceEntityName,
      Path: detail.path.join(" > "),
      Worksheet: detail.sheetName,
      "Source row": detail.rowNumber,
      "GL account": detail.glAccount,
      Description: detail.description,
      "Source value": detail.sourceValue,
      "Ownership factor %": detail.ownershipFactor * 100,
      "Attributed value": detail.attributedValue,
      "Accounting class": detail.accountingClass,
      "Tax classification": detail.taxClassification,
      "In denominator": detail.includedInDenominator ? "Yes" : "No",
      "In numerator": detail.includedInNumerator ? "Yes" : "No",
      "Potential/review": detail.includedInPotential ? "Yes" : "No",
      "Rule notes": detail.ruleNotes.join("; "),
    })),
  );
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(details), "Calculation detail");

  const messages = [
    ...importResult.errors.map((message) => ({ Type: "Import blocker", Message: message })),
    ...importResult.warnings.map((message) => ({ Type: "Import warning", Message: message })),
    ...calculation.errors.map((message) => ({ Type: "Calculation error", Message: message })),
    ...calculation.warnings.map((message) => ({ Type: "Calculation warning", Message: message })),
  ];
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(messages), "Checks and warnings");

  const safePeriod = (importResult.period ?? "result").replace(/[^A-Za-z0-9_-]+/g, "_");
  XLSX.writeFile(workbook, `Participation_Exemption_Monitor_${safePeriod}.xlsx`);
}
