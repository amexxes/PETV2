# Participation Exemption Monitor

Single-page internal MVP for Dutch participation-exemption monitoring from flexible Excel workbooks.

## Version 0.2 changes

This version was revised after testing a real financial-statement workbook that contained one entity, a detailed trial balance, multiple amount/currency columns and no group-structure table.

- A missing ownership sheet is no longer automatically fatal.
- The tool can infer standalone entities from fields such as `BU`, `Business Unit`, `Entity ID` or workbook titles.
- A full legal name can be linked to an entity code found elsewhere in the workbook.
- Standalone entity asset analysis is clearly separated from full group participation analysis.
- Ownership and the 5% participation test remain `NOT_ASSESSED` when no ownership data is supplied.
- Reporting/base currency pairs are preferred over transaction-currency amounts.
- Financial-statement grouping fields such as `Grouping`, `Subgrouping1` and `Subgrouping2` are used as classification context.
- P&L, liability and equity rows are excluded from the asset calculation.
- Signed TB rows are netted. Clearing entries, FX rows and accumulated depreciation are not grossed up.
- Missing-entity errors are grouped instead of repeated for every TB row.
- Non-table worksheets are no longer shown with misleading false header detections.
- Calculation lineage includes the original worksheet and row number.

## What the application does

- Public Vercel website; no login.
- Reads the selected Excel workbook locally in the browser.
- Scans every worksheet.
- Detects structure, entity, TB, amount, currency and classification fields using aliases, fuzzy matching and data patterns.
- Reuses manually confirmed mappings in browser localStorage.
- Calculates recursive ownership-weighted asset results when a structure is available.
- Calculates standalone entity asset composition when ownership is absent.
- Keeps confirmed low-taxed items, potential investments and manual-review items separate.
- Exports results, recognition, entities, mappings, checks and source-level calculation details to Excel.

## Deployment through GitHub and Vercel

1. Upload the project files to a GitHub repository.
2. Import the repository into Vercel.
3. Keep the Framework Preset as **Next.js**.
4. Deploy.

No database, Blob store or environment variables are required for this browser-only version.

## Important limitation

A workbook without ownership data can support an entity-level asset analysis, but not a complete participation conclusion. Ownership, indirect subsidiaries, motive, subject-to-tax and unresolved tax classifications must still be provided or reviewed where relevant.
