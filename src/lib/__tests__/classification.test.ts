import { describe, expect, it } from "vitest";
import { classifyAccount } from "../classification";


describe("classification rules", () => {
  it("classifies inventory as operating", () => {
    const result = classifyAccount("110000", "Inventory finished goods");
    expect(result.accountingClass).toBe("inventory");
    expect(result.taxClassification).toBe("operating");
  });

  it("classifies securities as a potential free investment, not automatically low-taxed", () => {
    const result = classifyAccount("150000", "Marketable securities portfolio");
    expect(result.accountingClass).toBe("investment");
    expect(result.taxClassification).toBe("potential_free_investment");
  });

  it("keeps cash as a review item", () => {
    const result = classifyAccount("140000", "Cash and cash equivalents");
    expect(result.accountingClass).toBe("cash");
    expect(result.taxClassification).toBe("manual_review");
  });

  it("keeps intercompany financing as a review item", () => {
    const result = classifyAccount("130000", "Intercompany loan receivable");
    expect(result.accountingClass).toBe("group_financing");
    expect(result.taxClassification).toBe("manual_review");
  });
});
