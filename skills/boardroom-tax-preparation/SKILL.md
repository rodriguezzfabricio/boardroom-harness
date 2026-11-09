---
name: boardroom-tax-preparation
description: Prepare tax registration research, tax calendars, bookkeeping reconciliation questions and accountant handoff packets. Use for sales tax, estimated taxes, 1099 preparation or tax records; do not route sales tax to sales outreach.
---
# Tax preparation

Determine the jurisdiction, entity classification, relevant period and requested deliverable from supplied facts. Missing facts stay unknown. A calendar or registration question does not require closed books; an estimate based on ledger income does require a reconciled period and an explicit distinction between cash and accrual figures.

Use `web_search`, `research_read`, and `evidence_read` for current primary tax-authority sources. Record jurisdiction, effective date, filing period and source for each deadline or rate. Do not reuse a rate from memory or treat an online article as a government determination. Use `boardroom_calculate` for arithmetic with stated units and periods.

For accountant preparation, organize income, expenses, prior payments, contractor records and missing documents. Distinguish reported transactions, reconciliation adjustments, assumptions and unresolved classifications. A missing accounting connection is a request for an export or sign-in, not evidence that the business has no transactions. Do not claim books are closed from the presence of a spreadsheet.

Use `artifact_write` for a concrete calendar, registration checklist or accountant packet, with source references and missing inputs. Read full peer evidence before reviewing it. Registration submissions, tax filings and payments are not performed by this worker. The controller handles any later authorized action separately.

This adapted Boardroom workflow implements the relevant accountant-preparation boundaries from Anthropic's tax-prep and tax-season-organizer skills. See https://github.com/anthropics/knowledge-work-plugins/tree/main/small-business. Native connector names in that library are not assumed to exist here; inspect actual Boardroom connections instead.
