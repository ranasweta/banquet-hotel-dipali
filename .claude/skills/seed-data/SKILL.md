---
name: seed-data
description: What the seed script must load — properties, venues, bundles, rate cards, menu tiers/items, lodging inventory, event types, roles, and the 15 seed users. Use when writing, regenerating, or auditing seed data, menus, or rate cards.
---

# Seed data inventory

Seed script must load: 4 properties, all venues + 4 bundles with rate cards **per event
type** (from the hotel's 2026 venue proposal, not PRD §3), menu
tiers/categories/items from the two menu PDFs with pick-counts, wedding surcharge
Rs. 50, lodging inventory (Palace 36 rooms + 2 dormitories, Regency 49 rooms in blocks
A/B/C), event types (wedding = 3 contacts), modules list, roles with the default
permission matrix (PRD §2.1), and users: 2 higher_authority, 3 lodge, 5 booking,
3 banquet, 1 maintenance, **1 auditor/admin** (15 total).

Source ranking and the two rules that reach beyond the seed (a missing rate card is a
gate, never a zero; `pick_count = NULL` means every item is included) live in the root
`CLAUDE.md` — they apply whether or not this skill is loaded. Read
`docs/SEED_ASSUMPTIONS.md` before touching seed data, menus, or rate cards.
