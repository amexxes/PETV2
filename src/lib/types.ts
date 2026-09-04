export type FieldKey =
  | "entityId"
  | "entityName"
  | "parentEntity"
  | "ownershipPct"
  | "country"
  | "currency"
  | "period"
  | "glAccount"
  | "glDescription"
  | "balance"
  | "accountCategory"
  | "balanceSheetSide"
  | "fairValue"
  | "bookValue"
  | "taxRate"
  | "motiveTest"
  | "subjectToTaxTest";

export type SheetRole = "structure" | "trial_balance" | "fair_value" | "tax_master" | "other" | "error";
export type AnalysisMode = "group_structure" | "standalone_entities";

export type TaxClassification =
  | "operating"
  | "potential_free_investment"
  | "low_taxed_free_investment"
  | "excluded_specific_rule"
  | "manual_review"
  | "not_relevant";

export type AccountingClass =
  | "inventory"
  | "fixed_assets"
  | "trade_receivable"
  | "cash"
  | "group_financing"
  | "investment"
  | "participation"
  | "real_estate"
  | "other_asset"
  | "non_asset"
  | "unknown";

export type TestState = "PASS" | "FAIL" | "REVIEW" | "NOT_ASSESSED";

export interface DetectedField {
  field: FieldKey;
  columnIndex: number;
  header: string;
  confidence: number;
}

export interface SheetAnalysis {
  sheetName: string;
  rowCount: number;
  columnCount: number;
  headerRow: number | null;
  role: SheetRole;
  confidence: number;
  fields: DetectedField[];
  errors: string[];
  warnings: string[];
}

export interface EntityRecord {
  id: string;
  name: string;
  parentId: string | null;
  parentName?: string | null;
  ownershipPct: number;
  ownershipProvided: boolean;
  source: "structure" | "trial_balance" | "workbook_context";
  country?: string;
  currency?: string;
}

export interface TrialBalanceLine {
  id: string;
  sheetName: string;
  rowNumber: number;
  entityId: string;
  entityName: string;
  glAccount: string;
  description: string;
  rawBalance: number;
  value: number;
  currency?: string;
  accountCategory?: string;
  balanceSheetSide?: string;
  counterparty?: string;
  accountingClass: AccountingClass;
  taxClassification: TaxClassification;
  confidence: number;
  signals: string[];
  sourceClassification: "rule" | "saved_mapping" | "manual";
  isAsset: boolean;
  unresolved: boolean;
}

export interface FairValueAdjustment {
  entityKey: string;
  glAccount: string;
  fairValue: number;
}

export interface EntityTaxData {
  entityKey: string;
  taxRate?: number;
  motiveTest?: TestState;
  subjectToTaxTest?: TestState;
}

export interface ImportResult {
  fileName: string;
  fileSize: number;
  sheets: SheetAnalysis[];
  entities: EntityRecord[];
  lines: TrialBalanceLine[];
  fairValueAdjustments: FairValueAdjustment[];
  taxData: EntityTaxData[];
  errors: string[];
  warnings: string[];
  period?: string;
  reportingCurrency?: string;
  analysisMode: AnalysisMode;
  structureDetected: boolean;
}

export interface AccountMapping {
  key: string;
  glAccount: string;
  description: string;
  accountingClass: AccountingClass;
  taxClassification: TaxClassification;
  confidence: number;
  signals: string[];
  source: "rule" | "saved_mapping" | "manual";
}

export interface EntityCalculation {
  entityId: string;
  entityName: string;
  directOwnershipPct: number;
  ownershipProvided: boolean;
  analysisMode: AnalysisMode;
  totalRelevantAssets: number;
  confirmedLowTaxed: number;
  potentialFreeInvestments: number;
  unresolvedReview: number;
  confirmedRatio: number;
  upperBoundRatio: number;
  thirtySeventyApplied: boolean;
  participationTest: TestState;
  motiveTest: TestState;
  subjectToTaxTest: TestState;
  assetTest: TestState;
  overall: "LIKELY_QUALIFIES" | "REVIEW_REQUIRED" | "AT_RISK" | "NOT_APPLICABLE";
  status: "NORMAL" | "ATTENTION" | "HIGH_ATTENTION" | "TAX_REVIEW_REQUIRED" | "REVIEW_REQUIRED";
  contributions: CalculationContribution[];
}

export interface CalculationContribution {
  sourceEntityId: string;
  sourceEntityName: string;
  sheetName: string;
  rowNumber: number;
  glAccount: string;
  description: string;
  sourceValue: number;
  ownershipFactor: number;
  attributedValue: number;
  taxClassification: TaxClassification;
  accountingClass: AccountingClass;
  includedInDenominator: boolean;
  includedInNumerator: boolean;
  includedInPotential: boolean;
  path: string[];
  ruleNotes: string[];
}

export interface CalculationResult {
  calculations: EntityCalculation[];
  errors: string[];
  warnings: string[];
}
