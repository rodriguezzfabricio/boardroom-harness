---
name: boardroom-local-crm
description: Maintain a project-local CRM of contacts, deals, activity notes and next actions without a hosted CRM or login. Use for contact lists, pipeline organization and follow-up queues.
---
# Local CRM

Read existing records with `boardroom_crm_list` before proposing changes. Match contacts by exact normalized email; resolve ambiguous contacts before associating a deal. Use the saved record ID to update a record, with its current revision. Never invent a relationship, customer approval, conversation, sale, email address or deal value.

Each open deal should have a contact, stage, owner, next action and next-action date when known. Missing values remain empty, not guessed. State currency with deal amounts and store amounts in integer cents. A note records what was supplied and its source; an agent recommendation is not an activity that happened.

The foreground controller owns `boardroom_crm_save`, which can add or update local records. Specialist workers have read access and return proposed changes in a report. Use `boardroom_crm_export` for spreadsheet-ready CSV files. The database is authoritative; CSV exports are snapshots, not live synchronization.

Saving a local follow-up draft does not send it. Gmail and other external actions have separate tools and authorization. No hosted CRM account is needed.
