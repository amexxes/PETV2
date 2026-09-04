import { describe, expect, it } from "vitest";
import { parseWorkbookRows } from "../workbook";

const currentWorkbookShape = [
  { sheetName: "PL", rows: [["C0450 - test"], ["Statement of profits or losses"]] },
  { sheetName: "BS", rows: [["C0450 - Luxury Hotels Design & Construction Hong Kong Limited"], ["Statement of financial position"]] },
  {
    sheetName: "TB",
    rows: [
      ["Year", "BU", "Op Unit", "Account", "Account Description", "Currency", "Sum Transaction Amt", "Base Currency", "Sum Amount", "Grouping", "Subgrouping1", "Subgrouping2"],
      [2026, "C0450", 52924, 115300, "USD Operating Cash Account", "USD", 100, "HKD", 780, "Balance Sheet", "2 Current Assets", "Cash"],
      [2026, "C0450", 52924, 110000, "Inventory", "EUR", 50, "HKD", 430, "Balance Sheet", "2 Current Assets", "Inventory"],
    ],
  },
];

describe("flexible workbook recognition", () => {
  it("accepts a standalone BU workbook without a structure sheet", () => {
    const result = parseWorkbookRows("C0450 - FS 2026 July 2026.xlsx", 1, currentWorkbookShape);
    expect(result.errors).toEqual([]);
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].id).toBe("C0450");
    expect(result.entities[0].name).toBe("Luxury Hotels Design & Construction Hong Kong Limited");
    expect(result.lines).toHaveLength(2);
    expect(result.reportingCurrency).toBe("HKD");
    expect(result.lines[0].value).toBe(780);
  });

  it("recognises a shifted two-row header and currency in the balance header", () => {
    const result = parseWorkbookRows("layout.xlsx", 1, [{
      sheetName: "Data",
      rows: [
        ["Example South Africa (Pty) Ltd"],
        [],
        ["Entity", "Account", "Account", "Reporting"],
        ["Code", "Number", "Description", "Closing Balance ZAR"],
        ["ZA01", "1000", "Cash", "1.000,00"],
        ["ZA01", "1100", "Inventory", "2.500,00"],
      ],
    }]);
    expect(result.errors).toEqual([]);
    expect(result.lines).toHaveLength(2);
    expect(result.reportingCurrency).toBe("ZAR");
    expect(result.sheets[0].headerRow).toBe(3);
    expect(result.sheets[0].headerDepth).toBe(2);
  });

  it("derives a signed balance from separate debit and credit columns", () => {
    const result = parseWorkbookRows("debit-credit.xlsx", 1, [{
      sheetName: "General Ledger",
      rows: [
        ["Company", "GL Code", "Description", "Currency", "Debit", "Credit"],
        ["Example Ltd", "1000", "Cash", "GBP", 1000, 200],
      ],
    }]);
    expect(result.errors).toEqual([]);
    expect(result.lines[0].value).toBe(800);
    expect(result.reportingCurrency).toBe("GBP");
  });

  it("reads two trial-balance tables on one worksheet", () => {
    const result = parseWorkbookRows("two-tables.xlsx", 1, [{
      sheetName: "Data",
      rows: [
        ["Company Code", "GL Account", "Description", "Currency", "Balance"],
        ["A", "1000", "Inventory", "EUR", 100],
        [],
        ["Company Code", "GL Account", "Description", "Currency", "Balance"],
        ["B", "1000", "Inventory", "EUR", 200],
      ],
    }]);
    expect(result.errors).toEqual([]);
    expect(result.entities.map((entity) => entity.id)).toEqual(["A", "B"]);
    expect(result.lines).toHaveLength(2);
  });

  it("recognises small entity-specific sheets with an amount currency in the header", () => {
    const result = parseWorkbookRows("small-entities.xlsx", 1, [
      { sheetName: "Germany GmbH", rows: [["Account", "Description", "Amount EUR"], ["1000", "Inventory", 100]] },
      { sheetName: "South Africa Pty Ltd", rows: [["Account", "Description", "Amount ZAR"], ["1000", "Inventory", 200]] },
    ]);
    expect(result.errors).toEqual([]);
    expect(result.entities).toHaveLength(2);
    expect(result.lines).toHaveLength(2);
    expect(result.reportingCurrency).toBeUndefined();
    expect(result.entities.map((entity) => entity.currency)).toEqual(["EUR", "ZAR"]);
  });

  it("blocks calculation when equally plausible amount columns use different currencies", () => {
    const result = parseWorkbookRows("ambiguous-currency.xlsx", 1, [{
      sheetName: "Entity A",
      rows: [["Account", "Description", "Amount USD", "Amount EUR"], ["1000", "Cash", 100, 90]],
    }]);
    expect(result.errors.some((error) => error.includes("different currencies"))).toBe(true);
  });

});
