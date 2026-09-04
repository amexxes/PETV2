"use client";

import { useMemo, useRef, useState } from "react";
import { applyClassificationToLines, calculate } from "@/lib/calculation";
import { exportWorkbook } from "@/lib/export";
import { mappingKey } from "@/lib/classification";
import { loadHistory, loadMappings, saveHistory, saveMapping } from "@/lib/storage";
import type { AccountMapping, EntityCalculation, ImportResult, TaxClassification, TestState } from "@/lib/types";
import { aggregateMappings, parseWorkbook } from "@/lib/workbook";

const TAX_CLASSIFICATIONS: Array<{ value: TaxClassification; label: string }> = [
  { value: "operating", label: "Operating asset" },
  { value: "potential_free_investment", label: "Potential free investment" },
  { value: "low_taxed_free_investment", label: "Low-taxed free investment" },
  { value: "excluded_specific_rule", label: "Excluded under specific rule" },
  { value: "manual_review", label: "Manual review" },
  { value: "not_relevant", label: "Not relevant / non-asset" },
];

const TEST_STATES: TestState[] = ["PASS", "FAIL", "REVIEW", "NOT_ASSESSED"];
const APP_VERSION = "0.3.1";

function formatMoney(value: number, currency?: string): string {
  const notation = Math.abs(value) >= 1_000_000 ? "compact" : "standard";
  if (currency) {
    try {
      return new Intl.NumberFormat("en-GB", { style: "currency", currency, maximumFractionDigits: 0, notation }).format(value);
    } catch {
      // Fall through to a plain number if a non-standard currency label is supplied.
    }
  }
  const formatted = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0, notation }).format(value);
  return currency ? `${formatted} ${currency}` : formatted;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function statusLabel(status: EntityCalculation["status"]): string {
  return status.replaceAll("_", " ");
}

function statusClass(status: string): string {
  if (status.includes("NORMAL") || status === "PASS" || status === "LIKELY_QUALIFIES") return "status good";
  if (status.includes("ATTENTION")) return "status attention";
  if (status.includes("FAIL") || status.includes("RISK") || status.includes("TAX_REVIEW")) return "status risk";
  return "status review";
}

function MessageItems({ items, limit = 10 }: { items: string[]; limit?: number }) {
  const visible = items.slice(0, limit);
  const remaining = items.length - visible.length;
  return (
    <>
      {visible.map((item) => <div key={item}>- {item}</div>)}
      {remaining > 0 && (
        <details className="message-more">
          <summary>{remaining} more message(s)</summary>
          {items.slice(limit).map((item) => <div key={item}>- {item}</div>)}
        </details>
      )}
    </>
  );
}

export function Monitor() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [period, setPeriod] = useState("");
  const [calculated, setCalculated] = useState(false);

  const calculation = useMemo(() => (importResult && calculated ? calculate(importResult) : null), [importResult, calculated]);
  const mappings = useMemo(() => (importResult ? aggregateMappings(importResult.lines) : []), [importResult]);
  const reviewMappings = mappings.filter((mapping) => mapping.taxClassification === "manual_review" || mapping.taxClassification === "potential_free_investment" || mapping.confidence < 0.65);
  const selected = calculation?.calculations.find((item) => item.entityId === selectedId) ?? calculation?.calculations[0] ?? null;
  const history = useMemo(() => {
    if (!selected) return [];
    return loadHistory().filter((point) => point.entityName === selected.entityName).sort((a, b) => a.period.localeCompare(b.period)).slice(-6);
  }, [selected, calculation]);

  async function handleFile(file: File) {
    if (!/\.(xlsx|xlsb|xls)$/i.test(file.name)) {
      window.alert("Please upload an Excel workbook (.xlsx, .xlsb or .xls). CSV is not suitable because the tool needs to inspect every tab.");
      return;
    }
    setBusy(true);
    setCalculated(false);
    try {
      const result = await parseWorkbook(file, loadMappings());
      setImportResult(result);
      setPeriod(result.period ?? "");
      setSelectedId(null);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "The workbook could not be read.");
    } finally {
      setBusy(false);
    }
  }

  function overrideMapping(mapping: AccountMapping, classification: TaxClassification) {
    if (!importResult) return;
    const updatedLines = applyClassificationToLines(importResult.lines, mapping.glAccount, mapping.description, classification);
    const first = updatedLines.find((line) => mappingKey(line.glAccount, line.description) === mapping.key);
    if (first) {
      saveMapping({
        key: mapping.key,
        glAccount: mapping.glAccount,
        description: mapping.description,
        accountingClass: first.accountingClass,
        taxClassification: classification,
        confidence: 1,
        signals: [...mapping.signals, "Reviewed manually in the Participation Exemption Monitor."],
        source: "manual",
      });
    }
    setImportResult({ ...importResult, lines: updatedLines });
    setCalculated(false);
  }

  function updateTest(entityId: string, field: "motiveTest" | "subjectToTaxTest", value: TestState) {
    if (!importResult) return;
    const entity = importResult.entities.find((candidate) => candidate.id === entityId);
    if (!entity) return;
    const keys = new Set([entity.id, entity.name].map((key) => key.toLowerCase().replace(/[^a-z0-9]+/g, "")));
    const existingIndex = importResult.taxData.findIndex((item) => keys.has(item.entityKey));
    const next = [...importResult.taxData];
    if (existingIndex >= 0) next[existingIndex] = { ...next[existingIndex], [field]: value };
    else next.push({ entityKey: entity.id.toLowerCase().replace(/[^a-z0-9]+/g, ""), [field]: value });
    setImportResult({ ...importResult, taxData: next });
    setCalculated(false);
  }

  function runCalculation() {
    if (!importResult) return;
    if (importResult.errors.length) return;
    setCalculated(true);
    requestAnimationFrame(() => {
      const result = calculate(importResult);
      if (period && result.calculations.length) saveHistory(period, result.calculations);
      if (!selectedId && result.calculations[0]) setSelectedId(result.calculations[0].entityId);
    });
  }

  function clearAll() {
    setImportResult(null);
    setCalculated(false);
    setSelectedId(null);
    setPeriod("");
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <main className="page-shell">
      <header className="page-header">
        <div>
          <div className="eyebrow">RSM TAX TECHNOLOGY - INTERNAL CONCEPT | PARSER {APP_VERSION}</div>
          <h1>Participation Exemption Monitor</h1>
          <p>Upload Excel workbook - recognise structure and trial balances - review classifications - calculate - export evidence.</p>
        </div>
        <div className="privacy-note">Workbook processing is local to this browser in the MVP. The source file is not uploaded or stored by the application.</div>
      </header>

      <section className="section upload-section">
        <div className="section-heading">
          <div><span className="step">1</span><h2>Upload workbook</h2></div>
          {importResult && <button className="text-button" onClick={clearAll}>Clear</button>}
        </div>
        <div
          className={`dropzone ${dragging ? "dragging" : ""}`}
          onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            const file = event.dataTransfer.files[0];
            if (file) void handleFile(file);
          }}
          onClick={() => inputRef.current?.click()}
        >
          <input ref={inputRef} type="file" accept=".xlsx,.xlsb,.xls" hidden onChange={(event) => event.target.files?.[0] && void handleFile(event.target.files[0])} />
          <div className="upload-icon">↑</div>
          <strong>{busy ? "Reading workbook..." : importResult ? importResult.fileName : "Drop an Excel workbook here or choose a file"}</strong>
          <span>{importResult ? `${(importResult.fileSize / 1024 / 1024).toFixed(1)} MB` : "Every worksheet is scanned; sheet names, row positions and wording may differ."}</span>
        </div>
      </section>

      {importResult && (
        <>
          <section className="section">
            <div className="section-heading"><div><span className="step">2</span><h2>Workbook recognition</h2></div></div>
            <div className="summary-strip">
              <div><strong>{importResult.sheets.length}</strong><span>Sheets read</span></div>
              <div><strong>{importResult.entities.length}</strong><span>Entities</span></div>
              <div><strong>{importResult.lines.length.toLocaleString()}</strong><span>TB lines</span></div>
              <div><strong>{reviewMappings.length}</strong><span>Account mappings to review</span></div>
            </div>
            <div className="mode-note">
              <strong>{importResult.analysisMode === "group_structure" ? "Group participation analysis" : "Standalone entity asset analysis"}</strong>
              <span>{importResult.analysisMode === "group_structure" ? "Ownership structure detected in the workbook." : "No ownership structure detected; the asset test can be calculated, but ownership and the 5% participation test remain not assessed."}</span>
            </div>

            {(importResult.errors.length > 0 || importResult.warnings.length > 0) && (
              <div className="messages-grid">
                {importResult.errors.length > 0 && <div className="message error"><strong>Calculation blockers</strong><MessageItems items={importResult.errors} /></div>}
                {importResult.warnings.length > 0 && <div className="message warning"><strong>Warnings</strong><MessageItems items={importResult.warnings} /></div>}
              </div>
            )}

            <div className="table-wrap compact-table">
              <table>
                <thead><tr><th>Worksheet</th><th>Detected as</th><th>Header</th><th>Fields detected</th><th>Confidence</th></tr></thead>
                <tbody>
                  {importResult.sheets.map((sheet) => (
                    <tr key={sheet.sheetName}>
                      <td><strong>{sheet.sheetName}</strong></td>
                      <td>{sheet.role.replace("_", " ")}</td>
                      <td>{sheet.headerRow ? (sheet.headerDepth && sheet.headerDepth > 1 ? `Rows ${sheet.headerRow}-${sheet.headerRow + sheet.headerDepth - 1}` : `Row ${sheet.headerRow}`) : "-"}</td>
                      <td>{sheet.fields.map((field) => field.field).join(", ") || "No structured table detected"}</td>
                      <td>{Math.round(sheet.confidence * 100)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="section">
            <div className="section-heading">
              <div><span className="step">3</span><h2>Review account classifications</h2></div>
              <span className="section-note">Saved manual mappings are reused in later uploads on this browser.</span>
            </div>
            {reviewMappings.length === 0 ? (
              <div className="empty-state">No account mapping currently requires review.</div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>GL</th><th>Description</th><th>Detected class</th><th>Signals</th><th>Tax classification</th></tr></thead>
                  <tbody>
                    {reviewMappings.slice(0, 40).map((mapping) => (
                      <tr key={mapping.key}>
                        <td className="mono">{mapping.glAccount}</td>
                        <td>{mapping.description}</td>
                        <td>{mapping.accountingClass.replaceAll("_", " ")}<small>{Math.round(mapping.confidence * 100)}% confidence</small></td>
                        <td className="signals">{mapping.signals.slice(0, 2).join(" ")}</td>
                        <td>
                          <select value={mapping.taxClassification} onChange={(event) => overrideMapping(mapping, event.target.value as TaxClassification)}>
                            {TAX_CLASSIFICATIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {reviewMappings.length > 40 && <div className="table-foot">Showing the first 40 of {reviewMappings.length} mappings requiring review.</div>}
              </div>
            )}
          </section>

          <section className="section">
            <div className="section-heading actions-heading">
              <div><span className="step">4</span><h2>{importResult.analysisMode === "group_structure" ? "Calculate participation results" : "Calculate entity asset results"}</h2></div>
              <div className="action-row">
                <label className="period-field">Reporting period<input value={period} onChange={(event) => setPeriod(event.target.value)} placeholder="e.g. Q2 2026" /></label>
                <button className="primary-button" disabled={importResult.errors.length > 0} onClick={runCalculation}>{calculated ? "Recalculate" : "Run calculation"}</button>
              </div>
            </div>

            {calculation && (
              <>
                {calculation.errors.length > 0 && <div className="message error"><strong>Calculation error</strong>{calculation.errors.map((item) => <div key={item}>- {item}</div>)}</div>}
                {calculation.calculations.length > 0 && (
                  <div className="results-layout">
                    <div className="table-wrap results-table">
                      <table>
                        <thead><tr><th>Entity / participation</th><th>Ownership</th><th>Motive</th><th>Subject-to-tax</th><th>Confirmed</th><th>Upper bound</th><th>Status</th></tr></thead>
                        <tbody>
                          {calculation.calculations.map((item) => (
                            <tr key={item.entityId} className={selected?.entityId === item.entityId ? "selected-row" : ""} onClick={() => setSelectedId(item.entityId)}>
                              <td><strong>{item.entityName}</strong><small>{item.overall.replaceAll("_", " ")}</small></td>
                              <td>{item.ownershipProvided ? `${item.directOwnershipPct.toFixed(1)}%` : "Not provided"}</td>
                              <td onClick={(event) => event.stopPropagation()}>
                                <select value={item.motiveTest} onChange={(event) => updateTest(item.entityId, "motiveTest", event.target.value as TestState)}>{TEST_STATES.map((state) => <option key={state}>{state}</option>)}</select>
                              </td>
                              <td onClick={(event) => event.stopPropagation()}>
                                <select value={item.subjectToTaxTest} onChange={(event) => updateTest(item.entityId, "subjectToTaxTest", event.target.value as TestState)}>{TEST_STATES.map((state) => <option key={state}>{state}</option>)}</select>
                              </td>
                              <td className="number">{pct(item.confirmedRatio)}</td>
                              <td className="number">{pct(item.upperBoundRatio)}</td>
                              <td><span className={statusClass(item.status)}>{statusLabel(item.status)}</span></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {selected && (
                      <aside className="detail-card">
                        <div className="detail-title"><span>{selected.analysisMode === "group_structure" ? "Selected participation" : "Selected entity"}</span><h3>{selected.entityName}</h3></div>
                        <div className="main-ratio">{pct(selected.confirmedRatio)}</div>
                        <div className="ratio-caption">confirmed low-taxed free investments / relevant assets</div>
                        <div className="bar"><div className="bar-operating" style={{ width: `${Math.max(0, 100 - selected.upperBoundRatio * 100)}%` }} /><div className="bar-review" style={{ width: `${Math.max(0, (selected.upperBoundRatio - selected.confirmedRatio) * 100)}%` }} /><div className="bar-risk" style={{ width: `${Math.max(0, selected.confirmedRatio * 100)}%` }} /></div>
                        <div className="legend"><span><i className="dot operating" />Other assets</span><span><i className="dot review-dot" />Potential/review</span><span><i className="dot risk-dot" />Confirmed low-tax</span></div>
                        <dl className="metrics">
                          <div><dt>Relevant assets</dt><dd>{formatMoney(selected.totalRelevantAssets, selected.currency ?? importResult.reportingCurrency)}</dd></div>
                          <div><dt>Confirmed low-tax</dt><dd>{formatMoney(selected.confirmedLowTaxed, selected.currency ?? importResult.reportingCurrency)}</dd></div>
                          <div><dt>Potential free investment</dt><dd>{formatMoney(selected.potentialFreeInvestments, selected.currency ?? importResult.reportingCurrency)}</dd></div>
                          <div><dt>Manual review amount</dt><dd>{formatMoney(selected.unresolvedReview, selected.currency ?? importResult.reportingCurrency)}</dd></div>
                        </dl>
                        <div className="test-list">
                          <div><span>Participation (5%)</span><b className={statusClass(selected.participationTest)}>{selected.participationTest}</b></div>
                          <div><span>Motive test</span><b className={statusClass(selected.motiveTest)}>{selected.motiveTest}</b></div>
                          <div><span>Subject-to-tax</span><b className={statusClass(selected.subjectToTaxTest)}>{selected.subjectToTaxTest}</b></div>
                          <div><span>Asset test (&lt;50%)</span><b className={statusClass(selected.assetTest)}>{selected.assetTest}</b></div>
                        </div>
                        {history.length > 0 && <div className="history"><strong>Saved quarterly results</strong>{history.map((point) => <div key={`${point.period}-${point.savedAt}`}><span>{point.period}</span><span>{pct(point.confirmedRatio)}</span></div>)}</div>}
                      </aside>
                    )}
                  </div>
                )}

                {selected && (
                  <details className="lineage">
                    <summary>View calculation trace for {selected.entityName}</summary>
                    <div className="table-wrap">
                      <table>
                        <thead><tr><th>Source</th><th>Entity</th><th>GL</th><th>Description</th><th>Attributed value</th><th>Classification</th><th>Path / rule</th></tr></thead>
                        <tbody>
                          {selected.contributions.slice(0, 100).map((detail, index) => (
                            <tr key={`${detail.sourceEntityId}-${detail.glAccount}-${index}`}>
                              <td>{detail.sheetName} row {detail.rowNumber}</td><td>{detail.sourceEntityName}</td><td className="mono">{detail.glAccount}</td><td>{detail.description}</td><td className="number">{formatMoney(detail.attributedValue, detail.currency ?? selected.currency ?? importResult.reportingCurrency)}</td><td>{detail.taxClassification.replaceAll("_", " ")}</td><td className="signals">{detail.path.join(" > ")} {detail.ruleNotes.join(" ")}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                )}

                {calculation.calculations.length > 0 && (
                  <div className="export-row"><button className="secondary-button" onClick={() => void exportWorkbook(importResult, calculation)}>Export results and evidence (Excel)</button></div>
                )}
              </>
            )}
          </section>
        </>
      )}

      <footer>
        Decision-support tool only. Keyword rules suggest classifications; unresolved tax facts remain subject to professional review. Internal warning levels of 40% and 45% are monitoring thresholds, not statutory tests.
      </footer>
    </main>
  );
}
