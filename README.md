# Participation Exemption Monitor - parser 0.3.1

Single-page browser-based MVP for Dutch participation-exemption monitoring from flexible Excel workbooks.

## What changed in parser 0.3.1

- A group-structure sheet is optional for standalone entity asset analysis.
- `BU`, business-unit and company-code fields can identify an entity.
- The legal entity name can be taken from a workbook title on another sheet.
- Repeated missing-entity errors are grouped instead of listed once per TB row.
- All worksheets are scanned for structured tables.
- Header rows may start lower in a sheet and may span up to three rows.
- Small merged header cells are expanded before recognition.
- More than one trial-balance table on a worksheet can be read.
- Column order may differ.
- Separate debit and credit columns are supported.
- Reporting/base/functional-currency amounts are preferred over transaction-currency amounts.
- Standard ISO currency codes are supported, together with common currency labels and symbols.
- International number formats such as `1,234.56`, `1.234,56` and `(1,234.56)` are supported.
- Signed rows are retained so clearing entries, FX rows and accumulated depreciation are netted rather than grossed up.
- The page visibly shows `PARSER 0.3.1` so the deployed version can be checked.

## Verified against the supplied workbook

For `C0450 - FS 2026 July 2026.xlsx`, the parser returns:

- 4 worksheets read;
- 1 standalone entity;
- 356 trial-balance lines;
- HKD as reporting currency;
- no calculation blockers;
- July 2026 as reporting period.

## Update through GitHub and Vercel

1. Extract the update ZIP on your computer.
2. Upload the extracted files and folders into the root of the existing GitHub repository.
3. Replace files when GitHub asks.
4. Commit the changes.
5. Check that Vercel deploys that new commit to Production.
6. Open the site and confirm the header shows `PARSER 0.3.1`.

Do not upload the ZIP itself as a file in the repository. Vercel will not replace the application source from an unopened ZIP.

## Limits

The parser covers common financial-statement and trial-balance layouts, but no rule-based parser can safely understand every possible workbook automatically. If essential fields cannot be identified with sufficient confidence, the tool stops rather than guessing. A later version should add an on-screen fallback where the user can select the correct sheet, header row and columns.
