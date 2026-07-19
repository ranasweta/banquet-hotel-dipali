-- ============================================================
-- Hotel Dipali Banquet & Event Management System
-- PostgreSQL 15+ schema · v1.1 · matches PRD v1.1
-- Money is stored in PAISE (BIGINT). Never store rupees as float.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";    -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "btree_gist";  -- room overlap exclusion

-- ---------- Enumerated types ----------
CREATE TYPE event_status AS ENUM
  ('enquiry','confirmed','in_progress','completed','locked','billed','closed','cancelled');
CREATE TYPE perm_action    AS ENUM ('view','create_edit','delete');
CREATE TYPE exception_kind AS ENUM
  ('menu_increase','room_allocation_35plus','discount_over_cap','overdue_wedding_balance','other');
CREATE TYPE exception_status AS ENUM ('pending','approved','rejected','approved_modified');
CREATE TYPE payment_kind   AS ENUM ('advance_block','part_payment','settlement','refund');
CREATE TYPE discount_head  AS ENUM ('menu','venue','room','overall');
CREATE TYPE doc_kind       AS ENUM ('aadhaar_front','aadhaar_back','receipt','other');
CREATE TYPE signoff_role   AS ENUM ('banquet_manager','lodge_manager','maintenance','booking_manager');

-- ============================================================
-- 1. Identity, roles, permissions
-- ============================================================
CREATE TABLE roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,             -- 'booking_manager', 'higher_authority', ...
  is_system   boolean NOT NULL DEFAULT false,   -- system roles cannot be deleted
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE modules (
  code        text PRIMARY KEY                  -- 'bookings','calendar','menus','menu_master',
);                                              -- 'rooms','maintenance','approvals','billing',
                                                -- 'roles_users','audit'

CREATE TABLE role_permissions (
  role_id     uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  module_code text NOT NULL REFERENCES modules(code),
  action      perm_action NOT NULL,
  PRIMARY KEY (role_id, module_code, action)
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name     text NOT NULL,
  mobile        text NOT NULL UNIQUE,
  email         text UNIQUE,
  password_hash text NOT NULL,
  role_id       uuid NOT NULL REFERENCES roles(id),
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- 2. Property masters
-- ============================================================
CREATE TABLE properties (
  id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name  text NOT NULL UNIQUE                    -- 'Palace','Regency','Dipali Grand','Residency'
);

CREATE TABLE venues (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id  uuid NOT NULL REFERENCES properties(id),
  name         text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('hall','lawn')),
  capacity_min int  NOT NULL CHECK (capacity_min >= 0),
  capacity_max int  NOT NULL CHECK (capacity_max >= capacity_min),
  is_active    boolean NOT NULL DEFAULT true,
  UNIQUE (property_id, name)
);

-- Bundles: 'Imperial + Kohinoor', 'Lotus + Signature', 'Gulmohar + Middle'
CREATE TABLE venue_bundles (
  id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name  text NOT NULL UNIQUE
);
CREATE TABLE venue_bundle_members (
  bundle_id uuid NOT NULL REFERENCES venue_bundles(id) ON DELETE CASCADE,
  venue_id  uuid NOT NULL REFERENCES venues(id),
  PRIMARY KEY (bundle_id, venue_id)
);

CREATE TABLE event_types (
  code            text PRIMARY KEY,             -- 'wedding','engagement','birthday',...
  display_name    text NOT NULL,
  contact_numbers int NOT NULL DEFAULT 1,       -- wedding = 3, others = 1 (FR-1.11)
  is_wedding      boolean NOT NULL DEFAULT false
);

-- Venue rental rates per event type, effective-dated
CREATE TABLE venue_rate_cards (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id       uuid REFERENCES venues(id),
  bundle_id      uuid REFERENCES venue_bundles(id),
  event_type     text NOT NULL REFERENCES event_types(code),
  rate_paise     bigint NOT NULL CHECK (rate_paise >= 0),
  effective_from date NOT NULL,
  CHECK (num_nonnulls(venue_id, bundle_id) = 1)
);

-- ============================================================
-- 3. Menu masters (data-driven, FR-3.1)
-- ============================================================
CREATE TABLE menu_tiers (
  id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE                     -- 'Silver','Gold','Platinum','Diamond','Crown',
);                                              -- 'Breakfast Gold','High Tea Silver',...

CREATE TABLE menu_tier_prices (
  tier_id                 uuid NOT NULL REFERENCES menu_tiers(id) ON DELETE CASCADE,
  effective_from          date NOT NULL,
  base_rate_paise         bigint NOT NULL CHECK (base_rate_paise > 0),
  wedding_surcharge_paise bigint NOT NULL DEFAULT 5000,  -- Rs. 50 (BR-M5)
  PRIMARY KEY (tier_id, effective_from)
);

CREATE TABLE menu_categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tier_id    uuid NOT NULL REFERENCES menu_tiers(id) ON DELETE CASCADE,
  name       text NOT NULL,                     -- 'Welcome drink','Soup','Veg starters',...
  -- NULL = every item in this category is included (no choice to make). The printed
  -- cards carry no "(ANY N)" for breads, salad bar, accompaniments, breakfast and
  -- high tea. Such categories render read-only, always count complete, and are
  -- excluded from the free-increase rule (BR-M2) and menu exceptions (BR-M3).
  pick_count int  CHECK (pick_count IS NULL OR pick_count > 0),
  -- BR-M2: only these four categories are eligible for the one free increase
  free_increase_eligible boolean NOT NULL DEFAULT false,
  sort_order int NOT NULL DEFAULT 0,
  UNIQUE (tier_id, name),
  -- An all-included category can never be increased.
  CHECK (NOT (pick_count IS NULL AND free_increase_eligible))
);

CREATE TABLE menu_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid NOT NULL REFERENCES menu_categories(id) ON DELETE CASCADE,
  name        text NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  UNIQUE (category_id, name)
);

-- ============================================================
-- 4. Events and sub-events
-- ============================================================
-- Human-readable event references: 'E-1000', 'E-1001', … The booking service inserts
-- code = 'E-' || nextval('event_code_seq'), so codes are unique without a max()+1 race.
CREATE SEQUENCE IF NOT EXISTS event_code_seq START 1000;

CREATE TABLE events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,           -- human ref: 'E-1042'
  guest_name    text NOT NULL,
  event_type    text NOT NULL REFERENCES event_types(code),
  status        event_status NOT NULL DEFAULT 'enquiry',
  first_date    date,                           -- derived: min(sub_events.event_date)
  last_date     date,
  proposal_total_paise bigint NOT NULL DEFAULT 0,  -- recomputed on every relevant change
  created_by    uuid NOT NULL REFERENCES users(id),
  confirmed_at  timestamptz,
  locked_at     timestamptz,
  locked_by     uuid REFERENCES users(id),
  cancelled_at  timestamptz,
  cancel_reason text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE event_contacts (
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  phone    text NOT NULL,
  label    text,                                -- 'primary','father','coordinator'
  PRIMARY KEY (event_id, phone)
);
-- FR-1.11 (3 contacts for weddings, 1 otherwise): enforced in application service
-- and re-checked by the confirmation transaction.

CREATE TABLE guest_documents (                   -- FR-1.10 KYC; store object-storage keys,
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- never raw images in the DB
  event_id   uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  kind       doc_kind NOT NULL,
  file_key   text NOT NULL,                     -- encrypted-at-rest bucket path
  uploaded_by uuid NOT NULL REFERENCES users(id),
  uploaded_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_doc_per_kind ON guest_documents(event_id, kind)
  WHERE kind IN ('aadhaar_front','aadhaar_back');

CREATE TABLE sub_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name        text NOT NULL,                    -- 'Sangeet','Wedding','Reception',...
  event_date  date NOT NULL,
  start_time  time NOT NULL,
  end_time    time NOT NULL,
  venue_id    uuid REFERENCES venues(id),
  bundle_id   uuid REFERENCES venue_bundles(id),
  pax         int NOT NULL CHECK (pax > 0),
  pax_override_note text,                       -- FR-2.6 soft capacity override
  venue_rate_paise bigint NOT NULL DEFAULT 0,   -- snapshot from rate card at confirm
  CHECK (num_nonnulls(venue_id, bundle_id) = 1),
  -- A zero-length window would occupy nothing and clash with nothing. end_time < start_time
  -- is legal and means the window runs past midnight into the next day (see venue_bookings).
  CHECK (start_time <> end_time)
);

-- ============================================================
-- 5. Venue bookings — THE clash guarantee (time-overlap model, BR-C1)
-- ============================================================
-- One row per (venue, occupied time window). The GiST exclusion constraint makes an
-- overlapping booking on the same venue physically impossible, even under concurrent
-- confirms (NFR-2) — the same mechanism room_allocations uses for rooms.
--
-- House rule (BR-C1, amended 17 Jul 2026): a venue may host any number of sub-events on
-- a day so long as their time windows do not overlap. There are no fixed slots and no
-- 11 AM handover. Back-to-back is allowed: occupancy is a half-open range '[)', so a
-- sub-event ending 15:00 and another starting 15:00 do NOT conflict.
--
-- Bundles (FR-2.3): booking a bundle inserts one row per member venue, so it blocks each
-- member individually, and booking a member blocks the bundle — both fall out of the
-- per-venue exclusion for free.
--
-- Past midnight: a sub-event with end_time <= start_time runs into the next day. The
-- booking service builds occupancy = [event_date + start_time,
-- event_date + 1 day + end_time), so the exclusion catches next-morning clashes too.
CREATE TABLE venue_bookings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id     uuid NOT NULL REFERENCES venues(id),
  sub_event_id uuid NOT NULL REFERENCES sub_events(id) ON DELETE CASCADE,
  event_id     uuid NOT NULL REFERENCES events(id),
  occupancy    tsrange NOT NULL,
  -- FR-4.3-style guarantee for venues: no two overlapping windows on one venue.
  EXCLUDE USING gist (venue_id WITH =, occupancy WITH &&)
);
CREATE INDEX vb_by_event ON venue_bookings(event_id);
CREATE INDEX vb_by_occupancy ON venue_bookings USING gist (occupancy);

-- ============================================================
-- 6. Menu snapshots (BR-M1..M5)
-- ============================================================
CREATE TABLE sub_event_menus (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sub_event_id          uuid NOT NULL UNIQUE REFERENCES sub_events(id) ON DELETE CASCADE,
  tier_id               uuid NOT NULL REFERENCES menu_tiers(id),
  tier_name             text NOT NULL,          -- snapshot
  base_rate_paise       bigint NOT NULL,        -- snapshot
  surcharge_paise       bigint NOT NULL DEFAULT 0,  -- Rs. 50/plate if wedding (BR-M5)
  is_complete           boolean NOT NULL DEFAULT false,
  free_increase_category uuid REFERENCES menu_categories(id),  -- BR-M2: at most one, tracked
  is_tentative          boolean NOT NULL DEFAULT true,         -- FR-1.12
  saved_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sub_event_menu_categories (         -- snapshot of pick rules incl. increases
  menu_id       uuid NOT NULL REFERENCES sub_event_menus(id) ON DELETE CASCADE,
  category_name text NOT NULL,
  -- NULL mirrors menu_categories.pick_count: all items included. The full item list
  -- is copied into sub_event_menu_selections at save time, so later master edits
  -- never change what a booked event gets.
  base_pick     int CHECK (base_pick IS NULL OR base_pick > 0),
  extra_picks   int NOT NULL DEFAULT 0,          -- free increase or approved exception
  exception_id  uuid,                            -- FK added after exceptions table
  PRIMARY KEY (menu_id, category_name),
  -- An all-included category can never be increased.
  CHECK (NOT (base_pick IS NULL AND extra_picks > 0))
);

CREATE TABLE sub_event_menu_selections (
  menu_id       uuid NOT NULL REFERENCES sub_event_menus(id) ON DELETE CASCADE,
  category_name text NOT NULL,
  item_name     text NOT NULL,                   -- snapshot by name, survives master edits
  note          text,                            -- "dal spicy" — a preference, never a charge
  PRIMARY KEY (menu_id, category_name, item_name)
);

CREATE TABLE sub_event_addons (                  -- FR-3.6
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sub_event_id uuid NOT NULL REFERENCES sub_events(id) ON DELETE CASCADE,
  description text NOT NULL,
  rate_paise  bigint NOT NULL CHECK (rate_paise >= 0),
  qty         int NOT NULL DEFAULT 1 CHECK (qty > 0)
);

-- ============================================================
-- 7. Exceptions / Higher Authority approvals (FR-6.x)
-- ============================================================
CREATE TABLE exceptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  kind        exception_kind NOT NULL,
  status      exception_status NOT NULL DEFAULT 'pending',
  payload     jsonb NOT NULL,                   -- what was requested, machine-readable
  raised_by   uuid NOT NULL REFERENCES users(id),
  raised_at   timestamptz NOT NULL DEFAULT now(),
  decided_by  uuid REFERENCES users(id),
  decided_at  timestamptz,
  remark      text                              -- mandatory on reject (app-enforced)
);
CREATE INDEX exceptions_pending ON exceptions(status) WHERE status = 'pending';

-- ON DELETE SET NULL: an exception is normally decided, not deleted, but if it ever is
-- (or an event is deleted, cascading its exceptions), the snapshot category simply loses
-- its link rather than blocking the delete. The pick is governed by extra_picks, not this FK.
ALTER TABLE sub_event_menu_categories
  ADD CONSTRAINT semc_exception_fk FOREIGN KEY (exception_id) REFERENCES exceptions(id)
  ON DELETE SET NULL;

-- ============================================================
-- 8. Lodging (FR-4.x)
-- ============================================================
CREATE TABLE lodging_units (
  id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE                     -- 'Palace','Regency','Grand/Regency A-block'
);

CREATE TABLE rooms (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id         uuid NOT NULL REFERENCES lodging_units(id),
  block           text,                         -- 'A','B','C'
  room_no         text NOT NULL,
  room_type       text NOT NULL,                -- 'deluxe','semi_suite','suite',
                                                -- 'presidential_suite','executive_deluxe','dormitory'
  beds            int NOT NULL DEFAULT 2,       -- dormitory: 18 or 30
  rack_rate_paise bigint NOT NULL,
  is_active       boolean NOT NULL DEFAULT true,
  UNIQUE (unit_id, room_no)
);

CREATE TABLE room_requirements (                 -- FR-1.6 handoff from wizard step 4
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id  uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  room_type text NOT NULL,
  count     int NOT NULL CHECK (count > 0),
  check_in  date NOT NULL,
  check_out date NOT NULL CHECK (check_out > check_in)
);

CREATE TABLE room_allocations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  room_id      uuid NOT NULL REFERENCES rooms(id),
  stay         daterange NOT NULL,              -- [check_in, check_out)
  rate_paise   bigint NOT NULL,                 -- snapshot (rack or negotiated)
  discount_paise bigint NOT NULL DEFAULT 0,     -- per-room; caps in BR-D1 (see trigger note)
  override_note  text,                          -- required if unit != preferred (BR-L1)
  allocated_by uuid NOT NULL REFERENCES users(id),
  -- FR-4.3: same room can never overlap two events — database-guaranteed
  EXCLUDE USING gist (room_id WITH =, stay WITH &&)
);
-- BR-L2 (35+ rooms => Higher Authority) and BR-D1 (Rs.500/Rs.1000 per-room discount
-- caps by room_type) are validated in the allocation service, which raises an
-- exception row and defers commit until approval.

-- ============================================================
-- 9. Discounts (BR-D1, BR-D2)
-- ============================================================
CREATE TABLE discounts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  head         discount_head NOT NULL,
  ref_id       uuid,                            -- sub_event / room_allocation the discount targets
  amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  remark       text NOT NULL,
  exception_id uuid REFERENCES exceptions(id),  -- set when over the 10% cap (BR-D2)
  given_by     uuid NOT NULL REFERENCES users(id),
  given_at     timestamptz NOT NULL DEFAULT now()
);
-- BR-D2: SUM(discounts.amount_paise) <= 10% of events.proposal_total_paise unless an
-- approved exception exists — enforced in the discount service inside one transaction.

-- ============================================================
-- 10. Payments (BR-P1, BR-P2, FR-7.7)
-- ============================================================
CREATE TABLE payments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  kind         payment_kind NOT NULL,
  amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  mode         text NOT NULL,                   -- 'cash','upi','bank','cheque'
  receipt_no   text NOT NULL UNIQUE,            -- internal receipt number
  received_on  date NOT NULL,
  recorded_by  uuid NOT NULL REFERENCES users(id),
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  note         text
);
CREATE INDEX payments_by_event ON payments(event_id);
-- BR-P1: the confirm transaction verifies SUM(payments where kind='advance_block')
-- >= 25% of proposal_total_paise BEFORE inserting venue_bookings rows.

CREATE TABLE payment_reminders (                 -- BR-P2 schedule state
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  remind_on  date NOT NULL,
  audience   text NOT NULL CHECK (audience IN ('booking_manager','higher_authority')),
  sent_at    timestamptz,
  UNIQUE (event_id, remind_on, audience)
);

-- ============================================================
-- 11. Maintenance (FR-5.x)
-- ============================================================
CREATE TABLE maintenance_entries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  item         text NOT NULL,                   -- 'Generator (extra hours)'
  qty          numeric(10,2) NOT NULL CHECK (qty > 0),
  unit         text NOT NULL DEFAULT 'nos',
  rate_paise   bigint NOT NULL CHECK (rate_paise >= 0),
  amount_paise bigint NOT NULL,
  remarks      text,
  file_key     text,                            -- receipt / meter photo
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  is_closed    boolean NOT NULL DEFAULT false
);

-- ============================================================
-- 11b. Change requests (FR-1.9)
-- ============================================================
-- Post-confirmation edits to pax / menu / add-ons apply directly (with audit versioning);
-- a change to a sub-event's date, time window or venue instead files a change request that
-- the Banquet Manager decides. On approval the service re-books the venue slot, so the same
-- GiST exclusion decides clashes — an approved move can still fail if the new slot was taken
-- in the meantime.
CREATE TABLE change_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  sub_event_id uuid NOT NULL REFERENCES sub_events(id) ON DELETE CASCADE,
  payload      jsonb NOT NULL,                 -- requested new date/time/venue fields
  summary      text NOT NULL,                  -- human-readable "what changes"
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reason       text,                           -- why the change is wanted
  requested_by uuid NOT NULL REFERENCES users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by   uuid REFERENCES users(id),
  decided_at   timestamptz,
  remark       text
);
CREATE INDEX change_requests_pending ON change_requests(status) WHERE status = 'pending';

-- ============================================================
-- 12. Lock, invoice, T&C (FR-7.x)
-- ============================================================
-- Chef delicacy requests: an off-menu ask ("sushi") that only the Chef prices. The charge is
-- PER PLATE and joins the tier rate + wedding surcharge in the food line. Deliberately not an
-- `exception`: that carries a verdict from the Authority, this carries an amount from the Chef.
CREATE TABLE chef_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sub_event_id  uuid NOT NULL REFERENCES sub_events(id) ON DELETE CASCADE,
  description   text NOT NULL,
  status        text NOT NULL DEFAULT 'pending',  -- pending | priced | declined
  charge_paise  bigint,                           -- per-plate addition, set by the Chef
  remark        text,
  requested_by  uuid NOT NULL REFERENCES users(id),
  requested_at  timestamptz NOT NULL DEFAULT now(),
  priced_by     uuid REFERENCES users(id),
  priced_at     timestamptz,
  CONSTRAINT chef_requests_status_chk CHECK (status IN ('pending', 'priced', 'declined')),
  CONSTRAINT chef_requests_charge_chk CHECK (
    (status = 'priced' AND charge_paise IS NOT NULL AND charge_paise >= 0)
    OR (status <> 'priced' AND charge_paise IS NULL)
  )
);
CREATE INDEX chef_requests_sub_event_idx ON chef_requests (sub_event_id);
CREATE INDEX chef_requests_pending_idx ON chef_requests (status) WHERE status = 'pending';

CREATE TABLE lock_signoffs (
  event_id    uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  designation signoff_role NOT NULL,
  signed_by   uuid NOT NULL REFERENCES users(id),
  signed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, designation)
);
-- Lock precondition (FR-7.1), checked in the lock transaction:
--   all sub_event_menus.is_complete, no pending exceptions, all four signoffs,
--   maintenance all closed, no unresolved room variance.

CREATE TABLE settings (                          -- singleton config incl. T&C text (FR-7.6)
  key   text PRIMARY KEY,                        -- 'terms_and_conditions','advance_pct',...
  value text NOT NULL,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invoices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      uuid NOT NULL UNIQUE REFERENCES events(id),
  invoice_no    text UNIQUE,                    -- assigned at finalisation only
  gross_paise   bigint NOT NULL,
  discount_paise bigint NOT NULL DEFAULT 0,
  tax_paise     bigint NOT NULL DEFAULT 0,
  net_paise     bigint NOT NULL,
  advances_paise bigint NOT NULL DEFAULT 0,
  balance_paise bigint NOT NULL,
  tnc_snapshot  text NOT NULL,                  -- T&C text frozen at draft time
  drafted_at    timestamptz NOT NULL DEFAULT now(),
  finalised_at  timestamptz,
  finalised_by  uuid REFERENCES users(id)
);

CREATE TABLE invoice_lines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id  uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  section     text NOT NULL,                    -- 'venue','food','rooms','maintenance','adjustment'
  description text NOT NULL,
  sac_hsn     text,
  qty         numeric(12,2) NOT NULL DEFAULT 1,
  rate_paise  bigint NOT NULL,
  gst_rate_bp int NOT NULL DEFAULT 0,           -- basis points: 1800 = 18%
  amount_paise bigint NOT NULL,
  tax_paise    bigint NOT NULL DEFAULT 0
);

-- ============================================================
-- 13. Audit log — append-only (FR-10.x)
-- ============================================================
CREATE TABLE audit_log (
  seq        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id   uuid,                              -- null for master-data changes
  entity     text NOT NULL,                     -- table name
  entity_id  uuid,
  field      text,
  old_value  text,
  new_value  text,
  action     text NOT NULL CHECK (action IN ('insert','update','delete','status','approval','lock')),
  user_id    uuid NOT NULL REFERENCES users(id),
  role_name  text NOT NULL,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_by_event ON audit_log(event_id, at);

-- Immutability: no UPDATE/DELETE ever, for anyone including the app role.
CREATE OR REPLACE FUNCTION forbid_audit_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER audit_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_audit_mutation();

-- ============================================================
-- 14. Locked-event immutability guard
-- ============================================================
-- Once events.status = 'locked', every child-table write must be rejected.
-- Implemented as one reusable trigger applied to all event-child tables.
CREATE OR REPLACE FUNCTION forbid_locked_event_write() RETURNS trigger AS $$
DECLARE eid uuid; st event_status;
BEGIN
  eid := COALESCE(NEW.event_id, OLD.event_id);
  SELECT status INTO st FROM events WHERE id = eid;
  IF st IN ('locked','billed','closed') THEN
    RAISE EXCEPTION 'event % is locked — record is immutable', eid;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'sub_events','event_contacts','guest_documents','venue_bookings',
    'room_allocations','room_requirements','discounts','maintenance_entries',
    'exceptions','payment_reminders','change_requests']
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_lock_guard BEFORE INSERT OR UPDATE OR DELETE ON %I
         FOR EACH ROW EXECUTE FUNCTION forbid_locked_event_write()', t, t);
  END LOOP;
END $$;
-- Note: payments are exempt (settlement arrives after lock) — recorded against
-- the invoice balance; lock_signoffs precede the lock by definition.

-- ============================================================
-- 14b. Locked-event immutability guard for the menu tables
-- ============================================================
-- The menu snapshot tables carry no event_id of their own — they hang off a sub_event
-- (sub_event_id) or a menu (menu_id -> sub_event_menus.sub_event_id). A companion guard
-- resolves the owning event through those keys so "locked means locked" (CLAUDE.md rule 6)
-- covers menus and add-ons too, not only the event_id-bearing children guarded above.
CREATE OR REPLACE FUNCTION forbid_locked_menu_write() RETURNS trigger AS $$
DECLARE eid uuid; st event_status; rec jsonb;
BEGIN
  rec := to_jsonb(COALESCE(NEW, OLD));
  IF rec ? 'sub_event_id' THEN
    SELECT se.event_id INTO eid FROM sub_events se
      WHERE se.id = (rec->>'sub_event_id')::uuid;
  ELSE
    SELECT se.event_id INTO eid
      FROM sub_event_menus m JOIN sub_events se ON se.id = m.sub_event_id
      WHERE m.id = (rec->>'menu_id')::uuid;
  END IF;
  SELECT status INTO st FROM events WHERE id = eid;
  IF st IN ('locked','billed','closed') THEN
    RAISE EXCEPTION 'event % is locked — record is immutable', eid;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'sub_event_menus','sub_event_menu_categories',
    'sub_event_menu_selections','sub_event_addons']
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_lock_guard BEFORE INSERT OR UPDATE OR DELETE ON %I
         FOR EACH ROW EXECUTE FUNCTION forbid_locked_menu_write()', t, t);
  END LOOP;
END $$;
