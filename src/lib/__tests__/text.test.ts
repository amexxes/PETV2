import { describe, expect, it } from "vitest";
import { extractCurrencyCode } from "../currency";
import { parseNumber } from "../text";

describe("number and currency recognition", () => {
  it("reads common international number formats", () => {
    expect(parseNumber("1,234.56")).toBeCloseTo(1234.56);
    expect(parseNumber("1.234,56")).toBeCloseTo(1234.56);
    expect(parseNumber("1 234,56")).toBeCloseTo(1234.56);
    expect(parseNumber("(1,234.56)")).toBeCloseTo(-1234.56);
    expect(parseNumber("1,234.56 CR")).toBeCloseTo(-1234.56);
  });

  it("recognises standard and labelled currencies", () => {
    expect(extractCurrencyCode("NOK")).toBe("NOK");
    expect(extractCurrencyCode("Closing Balance ZAR")).toBe("ZAR");
    expect(extractCurrencyCode("Hong Kong dollars")).toBe("HKD");
    expect(extractCurrencyCode("SG$ 100")).toBe("SGD");
  });
});
