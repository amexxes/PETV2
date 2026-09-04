import { describe, expect, it } from "vitest";
import { calculate } from "../calculation";
import type { ImportResult, TrialBalanceLine } from "../types";

function line(entityId: string, value: number, taxClassification: TrialBalanceLine["taxClassification"], id: string): TrialBalanceLine {
  return {
    id,
    sheetName: "TB",
    rowNumber: 1,
    entityId,
    entityName: entityId,
    glAccount: id,
    description: id,
    rawBalance: value,
    value,
    currency: "EUR",
    accountingClass: taxClassification === "operating" ? "inventory" : "investment",
    taxClassification,
    confidence: 1,
    signals: [],
    sourceClassification: "manual",
    isAsset: true,
    unresolved: taxClassification === "manual_review",
  };
}

function base(lines: TrialBalanceLine[], childOwnership = 100): ImportResult {
  return {
    fileName: "test.xlsx",
    fileSize: 1,
    sheets: [],
    entities: [
      { id: "NL", name: "NL HoldCo", parentId: null, ownershipPct: 100 },
      { id: "A", name: "A", parentId: "NL", ownershipPct: 100 },
      { id: "B", name: "B", parentId: "A", ownershipPct: childOwnership },
    ],
    lines,
    fairValueAdjustments: [],
    taxData: [],
    errors: [],
    warnings: [],
    reportingCurrency: "EUR",
  };
}

describe("calculation engine", () => {
  it("applies partial ownership recursively", () => {
    const result = calculate(base([
      line("A", 100, "operating", "A-op"),
      line("B", 100, "low_taxed_free_investment", "B-low"),
      line("B", 100, "operating", "B-op"),
    ], 50));
    const calc = result.calculations[0];
    expect(calc.totalRelevantAssets).toBe(200);
    expect(calc.confirmedLowTaxed).toBe(50);
    expect(calc.confirmedRatio).toBeCloseTo(0.25);
  });

  it("uses 50% as the point-in-time asset-test boundary", () => {
    const result = calculate(base([
      line("A", 50, "low_taxed_free_investment", "low"),
      line("A", 50, "operating", "op"),
    ]));
    const calc = result.calculations[0];
    expect(calc.confirmedRatio).toBeCloseTo(0.5);
    expect(calc.assetTest).toBe("FAIL");
  });

  it("returns review if unresolved potential could move the result over 50%", () => {
    const result = calculate(base([
      line("A", 40, "low_taxed_free_investment", "low"),
      line("A", 20, "potential_free_investment", "potential"),
      line("A", 40, "operating", "op"),
    ]));
    const calc = result.calculations[0];
    expect(calc.confirmedRatio).toBeCloseTo(0.4);
    expect(calc.upperBoundRatio).toBeCloseTo(0.6);
    expect(calc.assetTest).toBe("REVIEW");
  });

  it("allows another test to support a likely-qualifies assessment", () => {
    const input = base([
      line("A", 60, "low_taxed_free_investment", "low"),
      line("A", 40, "operating", "op"),
    ]);
    input.taxData = [{ entityKey: "a", motiveTest: "PASS", subjectToTaxTest: "NOT_ASSESSED" }];
    const calc = calculate(input).calculations[0];
    expect(calc.assetTest).toBe("FAIL");
    expect(calc.overall).toBe("LIKELY_QUALIFIES");
  });
});
