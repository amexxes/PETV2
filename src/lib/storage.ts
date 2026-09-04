import type { AccountMapping, EntityCalculation } from "./types";

const MAPPING_KEY = "pem:mappings:v1";
const HISTORY_KEY = "pem:history:v1";

export interface HistoryPoint {
  period: string;
  entityName: string;
  confirmedRatio: number;
  upperBoundRatio: number;
  savedAt: string;
}

export function loadMappings(): Record<string, AccountMapping> {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(window.localStorage.getItem(MAPPING_KEY) ?? "{}") as Record<string, AccountMapping>;
  } catch {
    return {};
  }
}

export function saveMapping(mapping: AccountMapping): void {
  if (typeof window === "undefined") return;
  const all = loadMappings();
  all[mapping.key] = { ...mapping, source: "manual" };
  window.localStorage.setItem(MAPPING_KEY, JSON.stringify(all));
}

export function loadHistory(): HistoryPoint[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(window.localStorage.getItem(HISTORY_KEY) ?? "[]") as HistoryPoint[];
  } catch {
    return [];
  }
}

export function saveHistory(period: string, calculations: EntityCalculation[]): void {
  if (typeof window === "undefined" || !period) return;
  const existing = loadHistory();
  const retained = existing.filter((point) => !calculations.some((calc) => calc.entityName === point.entityName && point.period === period));
  const next = [
    ...retained,
    ...calculations.map((calc) => ({
      period,
      entityName: calc.entityName,
      confirmedRatio: calc.confirmedRatio,
      upperBoundRatio: calc.upperBoundRatio,
      savedAt: new Date().toISOString(),
    })),
  ];
  window.localStorage.setItem(HISTORY_KEY, JSON.stringify(next.slice(-500)));
}
