import { pgTable, text, timestamp, unique, uuid, boolean, foreignKey, check, integer, bigint, date, uniqueIndex, time, index, jsonb, numeric, primaryKey, pgEnum, customType } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

// Drizzle introspection cannot parse PostgreSQL range types, so `pnpm db:pull` emits an
// invalid `unknown(...)` for room_allocations.stay (daterange) and venue_bookings.occupancy
// (tsrange). These custom types restore them. REAPPLY after any future `db:pull` — the
// range semantics live in the SQL (db/schema.sql), which remains the source of truth.
const daterange = customType<{ data: string }>({
	dataType() {
		return "daterange"
	},
})
const tsrange = customType<{ data: string }>({
	dataType() {
		return "tsrange"
	},
})

export const discountHead = pgEnum("discount_head", ['menu', 'venue', 'room', 'overall'])
export const docKind = pgEnum("doc_kind", ['aadhaar_front', 'aadhaar_back', 'receipt', 'other'])
export const eventStatus = pgEnum("event_status", ['enquiry', 'confirmed', 'in_progress', 'completed', 'locked', 'billed', 'closed', 'cancelled'])
export const exceptionKind = pgEnum("exception_kind", ['menu_increase', 'room_allocation_35plus', 'discount_over_cap', 'overdue_wedding_balance', 'other'])
export const exceptionStatus = pgEnum("exception_status", ['pending', 'approved', 'rejected', 'approved_modified'])
export const paymentKind = pgEnum("payment_kind", ['advance_block', 'part_payment', 'settlement', 'refund'])
export const permAction = pgEnum("perm_action", ['view', 'create_edit', 'delete'])
export const signoffRole = pgEnum("signoff_role", ['banquet_manager', 'lodge_manager', 'maintenance', 'booking_manager'])


export const schemaMigrations = pgTable("schema_migrations", {
	id: text().primaryKey().notNull(),
	appliedAt: timestamp("applied_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const roles = pgTable("roles", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: text().notNull(),
	isSystem: boolean("is_system").default(false).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("roles_name_key").on(table.name),
]);

export const modules = pgTable("modules", {
	code: text().primaryKey().notNull(),
});

export const users = pgTable("users", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	fullName: text("full_name").notNull(),
	mobile: text().notNull(),
	email: text(),
	passwordHash: text("password_hash").notNull(),
	roleId: uuid("role_id").notNull(),
	isActive: boolean("is_active").default(true).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.roleId],
			foreignColumns: [roles.id],
			name: "users_role_id_fkey"
		}),
	unique("users_mobile_key").on(table.mobile),
	unique("users_email_key").on(table.email),
]);

export const properties = pgTable("properties", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: text().notNull(),
}, (table) => [
	unique("properties_name_key").on(table.name),
]);

export const venues = pgTable("venues", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	propertyId: uuid("property_id").notNull(),
	name: text().notNull(),
	kind: text().notNull(),
	capacityMin: integer("capacity_min").notNull(),
	capacityMax: integer("capacity_max").notNull(),
	isActive: boolean("is_active").default(true).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.propertyId],
			foreignColumns: [properties.id],
			name: "venues_property_id_fkey"
		}),
	unique("venues_property_id_name_key").on(table.propertyId, table.name),
	check("venues_kind_check", sql`kind = ANY (ARRAY['hall'::text, 'lawn'::text])`),
	check("venues_capacity_min_check", sql`capacity_min >= 0`),
	check("venues_check", sql`capacity_max >= capacity_min`),
]);

export const venueBundles = pgTable("venue_bundles", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: text().notNull(),
}, (table) => [
	unique("venue_bundles_name_key").on(table.name),
]);

export const venueRateCards = pgTable("venue_rate_cards", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	venueId: uuid("venue_id"),
	bundleId: uuid("bundle_id"),
	eventType: text("event_type").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ratePaise: bigint("rate_paise", { mode: "number" }).notNull(),
	effectiveFrom: date("effective_from").notNull(),
}, (table) => [
	foreignKey({
			columns: [table.venueId],
			foreignColumns: [venues.id],
			name: "venue_rate_cards_venue_id_fkey"
		}),
	foreignKey({
			columns: [table.bundleId],
			foreignColumns: [venueBundles.id],
			name: "venue_rate_cards_bundle_id_fkey"
		}),
	foreignKey({
			columns: [table.eventType],
			foreignColumns: [eventTypes.code],
			name: "venue_rate_cards_event_type_fkey"
		}),
	check("venue_rate_cards_rate_paise_check", sql`rate_paise >= 0`),
	check("venue_rate_cards_check", sql`num_nonnulls(venue_id, bundle_id) = 1`),
]);

export const eventTypes = pgTable("event_types", {
	code: text().primaryKey().notNull(),
	displayName: text("display_name").notNull(),
	contactNumbers: integer("contact_numbers").default(1).notNull(),
	isWedding: boolean("is_wedding").default(false).notNull(),
});

export const menuTiers = pgTable("menu_tiers", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: text().notNull(),
}, (table) => [
	unique("menu_tiers_name_key").on(table.name),
]);

export const menuCategories = pgTable("menu_categories", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	tierId: uuid("tier_id").notNull(),
	name: text().notNull(),
	pickCount: integer("pick_count"),
	freeIncreaseEligible: boolean("free_increase_eligible").default(false).notNull(),
	sortOrder: integer("sort_order").default(0).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.tierId],
			foreignColumns: [menuTiers.id],
			name: "menu_categories_tier_id_fkey"
		}).onDelete("cascade"),
	unique("menu_categories_tier_id_name_key").on(table.tierId, table.name),
	check("menu_categories_pick_count_check", sql`(pick_count IS NULL) OR (pick_count > 0)`),
	check("menu_categories_check", sql`NOT ((pick_count IS NULL) AND free_increase_eligible)`),
]);

export const menuItems = pgTable("menu_items", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	categoryId: uuid("category_id").notNull(),
	name: text().notNull(),
	isActive: boolean("is_active").default(true).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.categoryId],
			foreignColumns: [menuCategories.id],
			name: "menu_items_category_id_fkey"
		}).onDelete("cascade"),
	unique("menu_items_category_id_name_key").on(table.categoryId, table.name),
]);

export const events = pgTable("events", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	code: text().notNull(),
	guestName: text("guest_name").notNull(),
	eventType: text("event_type").notNull(),
	status: eventStatus().default('enquiry').notNull(),
	firstDate: date("first_date"),
	lastDate: date("last_date"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	proposalTotalPaise: bigint("proposal_total_paise", { mode: "number" }).default(0).notNull(),
	createdBy: uuid("created_by").notNull(),
	confirmedAt: timestamp("confirmed_at", { withTimezone: true, mode: 'string' }),
	lockedAt: timestamp("locked_at", { withTimezone: true, mode: 'string' }),
	lockedBy: uuid("locked_by"),
	cancelledAt: timestamp("cancelled_at", { withTimezone: true, mode: 'string' }),
	cancelReason: text("cancel_reason"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.eventType],
			foreignColumns: [eventTypes.code],
			name: "events_event_type_fkey"
		}),
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "events_created_by_fkey"
		}),
	foreignKey({
			columns: [table.lockedBy],
			foreignColumns: [users.id],
			name: "events_locked_by_fkey"
		}),
	unique("events_code_key").on(table.code),
]);

export const guestDocuments = pgTable("guest_documents", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	eventId: uuid("event_id").notNull(),
	kind: docKind().notNull(),
	fileKey: text("file_key").notNull(),
	uploadedBy: uuid("uploaded_by").notNull(),
	uploadedAt: timestamp("uploaded_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("one_doc_per_kind").using("btree", table.eventId.asc().nullsLast().op("uuid_ops"), table.kind.asc().nullsLast().op("uuid_ops")).where(sql`(kind = ANY (ARRAY['aadhaar_front'::doc_kind, 'aadhaar_back'::doc_kind]))`),
	foreignKey({
			columns: [table.eventId],
			foreignColumns: [events.id],
			name: "guest_documents_event_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.uploadedBy],
			foreignColumns: [users.id],
			name: "guest_documents_uploaded_by_fkey"
		}),
]);

export const subEvents = pgTable("sub_events", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	eventId: uuid("event_id").notNull(),
	name: text().notNull(),
	eventDate: date("event_date").notNull(),
	startTime: time("start_time").notNull(),
	endTime: time("end_time").notNull(),
	venueId: uuid("venue_id"),
	bundleId: uuid("bundle_id"),
	pax: integer().notNull(),
	paxOverrideNote: text("pax_override_note"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	venueRatePaise: bigint("venue_rate_paise", { mode: "number" }).default(0).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.eventId],
			foreignColumns: [events.id],
			name: "sub_events_event_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.venueId],
			foreignColumns: [venues.id],
			name: "sub_events_venue_id_fkey"
		}),
	foreignKey({
			columns: [table.bundleId],
			foreignColumns: [venueBundles.id],
			name: "sub_events_bundle_id_fkey"
		}),
	check("sub_events_pax_check", sql`pax > 0`),
	check("sub_events_check", sql`num_nonnulls(venue_id, bundle_id) = 1`),
	check("sub_events_check1", sql`start_time <> end_time`),
]);

export const venueBookings = pgTable("venue_bookings", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	venueId: uuid("venue_id").notNull(),
	subEventId: uuid("sub_event_id").notNull(),
	eventId: uuid("event_id").notNull(),
	occupancy: tsrange("occupancy").notNull(),
}, (table) => [
	index("vb_by_event").using("btree", table.eventId.asc().nullsLast().op("uuid_ops")),
	index("vb_by_occupancy").using("gist", table.occupancy.asc().nullsLast().op("range_ops")),
	foreignKey({
			columns: [table.venueId],
			foreignColumns: [venues.id],
			name: "venue_bookings_venue_id_fkey"
		}),
	foreignKey({
			columns: [table.subEventId],
			foreignColumns: [subEvents.id],
			name: "venue_bookings_sub_event_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.eventId],
			foreignColumns: [events.id],
			name: "venue_bookings_event_id_fkey"
		}),
]);

export const subEventMenus = pgTable("sub_event_menus", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	subEventId: uuid("sub_event_id").notNull(),
	tierId: uuid("tier_id").notNull(),
	tierName: text("tier_name").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	baseRatePaise: bigint("base_rate_paise", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	surchargePaise: bigint("surcharge_paise", { mode: "number" }).default(0).notNull(),
	isComplete: boolean("is_complete").default(false).notNull(),
	freeIncreaseCategory: uuid("free_increase_category"),
	isTentative: boolean("is_tentative").default(true).notNull(),
	savedAt: timestamp("saved_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.subEventId],
			foreignColumns: [subEvents.id],
			name: "sub_event_menus_sub_event_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.tierId],
			foreignColumns: [menuTiers.id],
			name: "sub_event_menus_tier_id_fkey"
		}),
	foreignKey({
			columns: [table.freeIncreaseCategory],
			foreignColumns: [menuCategories.id],
			name: "sub_event_menus_free_increase_category_fkey"
		}),
	unique("sub_event_menus_sub_event_id_key").on(table.subEventId),
]);

export const subEventAddons = pgTable("sub_event_addons", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	subEventId: uuid("sub_event_id").notNull(),
	description: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ratePaise: bigint("rate_paise", { mode: "number" }).notNull(),
	qty: integer().default(1).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.subEventId],
			foreignColumns: [subEvents.id],
			name: "sub_event_addons_sub_event_id_fkey"
		}).onDelete("cascade"),
	check("sub_event_addons_rate_paise_check", sql`rate_paise >= 0`),
	check("sub_event_addons_qty_check", sql`qty > 0`),
]);

export const exceptions = pgTable("exceptions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	eventId: uuid("event_id").notNull(),
	kind: exceptionKind().notNull(),
	status: exceptionStatus().default('pending').notNull(),
	payload: jsonb().notNull(),
	raisedBy: uuid("raised_by").notNull(),
	raisedAt: timestamp("raised_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	decidedBy: uuid("decided_by"),
	decidedAt: timestamp("decided_at", { withTimezone: true, mode: 'string' }),
	remark: text(),
}, (table) => [
	index("exceptions_pending").using("btree", table.status.asc().nullsLast().op("enum_ops")).where(sql`(status = 'pending'::exception_status)`),
	foreignKey({
			columns: [table.eventId],
			foreignColumns: [events.id],
			name: "exceptions_event_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.raisedBy],
			foreignColumns: [users.id],
			name: "exceptions_raised_by_fkey"
		}),
	foreignKey({
			columns: [table.decidedBy],
			foreignColumns: [users.id],
			name: "exceptions_decided_by_fkey"
		}),
]);

export const lodgingUnits = pgTable("lodging_units", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: text().notNull(),
}, (table) => [
	unique("lodging_units_name_key").on(table.name),
]);

export const rooms = pgTable("rooms", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	unitId: uuid("unit_id").notNull(),
	block: text(),
	roomNo: text("room_no").notNull(),
	roomType: text("room_type").notNull(),
	beds: integer().default(2).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	rackRatePaise: bigint("rack_rate_paise", { mode: "number" }).notNull(),
	isActive: boolean("is_active").default(true).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.unitId],
			foreignColumns: [lodgingUnits.id],
			name: "rooms_unit_id_fkey"
		}),
	unique("rooms_unit_id_room_no_key").on(table.unitId, table.roomNo),
]);

export const roomRequirements = pgTable("room_requirements", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	eventId: uuid("event_id").notNull(),
	roomType: text("room_type").notNull(),
	count: integer().notNull(),
	checkIn: date("check_in").notNull(),
	checkOut: date("check_out").notNull(),
}, (table) => [
	foreignKey({
			columns: [table.eventId],
			foreignColumns: [events.id],
			name: "room_requirements_event_id_fkey"
		}).onDelete("cascade"),
	check("room_requirements_count_check", sql`count > 0`),
	check("room_requirements_check", sql`check_out > check_in`),
]);

export const roomAllocations = pgTable("room_allocations", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	eventId: uuid("event_id").notNull(),
	roomId: uuid("room_id").notNull(),
	stay: daterange("stay").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ratePaise: bigint("rate_paise", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	discountPaise: bigint("discount_paise", { mode: "number" }).default(0).notNull(),
	overrideNote: text("override_note"),
	allocatedBy: uuid("allocated_by").notNull(),
}, (table) => [
	foreignKey({
			columns: [table.eventId],
			foreignColumns: [events.id],
			name: "room_allocations_event_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.roomId],
			foreignColumns: [rooms.id],
			name: "room_allocations_room_id_fkey"
		}),
	foreignKey({
			columns: [table.allocatedBy],
			foreignColumns: [users.id],
			name: "room_allocations_allocated_by_fkey"
		}),
]);

export const paymentReminders = pgTable("payment_reminders", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	eventId: uuid("event_id").notNull(),
	remindOn: date("remind_on").notNull(),
	audience: text().notNull(),
	sentAt: timestamp("sent_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	foreignKey({
			columns: [table.eventId],
			foreignColumns: [events.id],
			name: "payment_reminders_event_id_fkey"
		}).onDelete("cascade"),
	unique("payment_reminders_event_id_remind_on_audience_key").on(table.eventId, table.remindOn, table.audience),
	check("payment_reminders_audience_check", sql`audience = ANY (ARRAY['booking_manager'::text, 'higher_authority'::text])`),
]);

export const discounts = pgTable("discounts", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	eventId: uuid("event_id").notNull(),
	head: discountHead().notNull(),
	refId: uuid("ref_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
	remark: text().notNull(),
	exceptionId: uuid("exception_id"),
	givenBy: uuid("given_by").notNull(),
	givenAt: timestamp("given_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.eventId],
			foreignColumns: [events.id],
			name: "discounts_event_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.exceptionId],
			foreignColumns: [exceptions.id],
			name: "discounts_exception_id_fkey"
		}),
	foreignKey({
			columns: [table.givenBy],
			foreignColumns: [users.id],
			name: "discounts_given_by_fkey"
		}),
	check("discounts_amount_paise_check", sql`amount_paise > 0`),
]);

export const payments = pgTable("payments", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	eventId: uuid("event_id").notNull(),
	kind: paymentKind().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
	mode: text().notNull(),
	receiptNo: text("receipt_no").notNull(),
	receivedOn: date("received_on").notNull(),
	recordedBy: uuid("recorded_by").notNull(),
	recordedAt: timestamp("recorded_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	note: text(),
}, (table) => [
	index("payments_by_event").using("btree", table.eventId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.eventId],
			foreignColumns: [events.id],
			name: "payments_event_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.recordedBy],
			foreignColumns: [users.id],
			name: "payments_recorded_by_fkey"
		}),
	unique("payments_receipt_no_key").on(table.receiptNo),
	check("payments_amount_paise_check", sql`amount_paise > 0`),
]);

export const maintenanceEntries = pgTable("maintenance_entries", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	eventId: uuid("event_id").notNull(),
	item: text().notNull(),
	qty: numeric({ precision: 10, scale:  2 }).notNull(),
	unit: text().default('nos').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ratePaise: bigint("rate_paise", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
	remarks: text(),
	fileKey: text("file_key"),
	createdBy: uuid("created_by").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	isClosed: boolean("is_closed").default(false).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.eventId],
			foreignColumns: [events.id],
			name: "maintenance_entries_event_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "maintenance_entries_created_by_fkey"
		}),
	check("maintenance_entries_qty_check", sql`qty > (0)::numeric`),
	check("maintenance_entries_rate_paise_check", sql`rate_paise >= 0`),
]);

export const changeRequests = pgTable("change_requests", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	eventId: uuid("event_id").notNull(),
	subEventId: uuid("sub_event_id").notNull(),
	payload: jsonb().notNull(),
	summary: text().notNull(),
	status: text().default('pending').notNull(),
	reason: text(),
	requestedBy: uuid("requested_by").notNull(),
	requestedAt: timestamp("requested_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	decidedBy: uuid("decided_by"),
	decidedAt: timestamp("decided_at", { withTimezone: true, mode: 'string' }),
	remark: text(),
}, (table) => [
	index("change_requests_pending").using("btree", table.status.asc().nullsLast().op("text_ops")).where(sql`(status = 'pending'::text)`),
	foreignKey({
			columns: [table.eventId],
			foreignColumns: [events.id],
			name: "change_requests_event_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.subEventId],
			foreignColumns: [subEvents.id],
			name: "change_requests_sub_event_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.requestedBy],
			foreignColumns: [users.id],
			name: "change_requests_requested_by_fkey"
		}),
	foreignKey({
			columns: [table.decidedBy],
			foreignColumns: [users.id],
			name: "change_requests_decided_by_fkey"
		}),
	check("change_requests_status_check", sql`status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])`),
]);

export const settings = pgTable("settings", {
	key: text().primaryKey().notNull(),
	value: text().notNull(),
	updatedBy: uuid("updated_by"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.updatedBy],
			foreignColumns: [users.id],
			name: "settings_updated_by_fkey"
		}),
]);

export const invoices = pgTable("invoices", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	eventId: uuid("event_id").notNull(),
	invoiceNo: text("invoice_no"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	grossPaise: bigint("gross_paise", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	discountPaise: bigint("discount_paise", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	taxPaise: bigint("tax_paise", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	netPaise: bigint("net_paise", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	advancesPaise: bigint("advances_paise", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	balancePaise: bigint("balance_paise", { mode: "number" }).notNull(),
	tncSnapshot: text("tnc_snapshot").notNull(),
	draftedAt: timestamp("drafted_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	finalisedAt: timestamp("finalised_at", { withTimezone: true, mode: 'string' }),
	finalisedBy: uuid("finalised_by"),
}, (table) => [
	foreignKey({
			columns: [table.eventId],
			foreignColumns: [events.id],
			name: "invoices_event_id_fkey"
		}),
	foreignKey({
			columns: [table.finalisedBy],
			foreignColumns: [users.id],
			name: "invoices_finalised_by_fkey"
		}),
	unique("invoices_event_id_key").on(table.eventId),
	unique("invoices_invoice_no_key").on(table.invoiceNo),
]);

export const invoiceLines = pgTable("invoice_lines", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	invoiceId: uuid("invoice_id").notNull(),
	section: text().notNull(),
	description: text().notNull(),
	sacHsn: text("sac_hsn"),
	qty: numeric({ precision: 12, scale:  2 }).default('1').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	ratePaise: bigint("rate_paise", { mode: "number" }).notNull(),
	gstRateBp: integer("gst_rate_bp").default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	taxPaise: bigint("tax_paise", { mode: "number" }).default(0).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.invoiceId],
			foreignColumns: [invoices.id],
			name: "invoice_lines_invoice_id_fkey"
		}).onDelete("cascade"),
]);

export const auditLog = pgTable("audit_log", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	seq: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "audit_log_seq_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	eventId: uuid("event_id"),
	entity: text().notNull(),
	entityId: uuid("entity_id"),
	field: text(),
	oldValue: text("old_value"),
	newValue: text("new_value"),
	action: text().notNull(),
	userId: uuid("user_id").notNull(),
	roleName: text("role_name").notNull(),
	at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("audit_by_event").using("btree", table.eventId.asc().nullsLast().op("timestamptz_ops"), table.at.asc().nullsLast().op("timestamptz_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "audit_log_user_id_fkey"
		}),
	check("audit_log_action_check", sql`action = ANY (ARRAY['insert'::text, 'update'::text, 'delete'::text, 'status'::text, 'approval'::text, 'lock'::text])`),
]);

export const venueBundleMembers = pgTable("venue_bundle_members", {
	bundleId: uuid("bundle_id").notNull(),
	venueId: uuid("venue_id").notNull(),
}, (table) => [
	foreignKey({
			columns: [table.bundleId],
			foreignColumns: [venueBundles.id],
			name: "venue_bundle_members_bundle_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.venueId],
			foreignColumns: [venues.id],
			name: "venue_bundle_members_venue_id_fkey"
		}),
	primaryKey({ columns: [table.bundleId, table.venueId], name: "venue_bundle_members_pkey"}),
]);

export const rolePermissions = pgTable("role_permissions", {
	roleId: uuid("role_id").notNull(),
	moduleCode: text("module_code").notNull(),
	action: permAction().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.roleId],
			foreignColumns: [roles.id],
			name: "role_permissions_role_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.moduleCode],
			foreignColumns: [modules.code],
			name: "role_permissions_module_code_fkey"
		}),
	primaryKey({ columns: [table.roleId, table.moduleCode, table.action], name: "role_permissions_pkey"}),
]);

export const eventContacts = pgTable("event_contacts", {
	eventId: uuid("event_id").notNull(),
	phone: text().notNull(),
	label: text(),
}, (table) => [
	foreignKey({
			columns: [table.eventId],
			foreignColumns: [events.id],
			name: "event_contacts_event_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.eventId, table.phone], name: "event_contacts_pkey"}),
]);

export const subEventMenuSelections = pgTable("sub_event_menu_selections", {
	menuId: uuid("menu_id").notNull(),
	categoryName: text("category_name").notNull(),
	itemName: text("item_name").notNull(),
	note: text(),
}, (table) => [
	foreignKey({
			columns: [table.menuId],
			foreignColumns: [subEventMenus.id],
			name: "sub_event_menu_selections_menu_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.menuId, table.categoryName, table.itemName], name: "sub_event_menu_selections_pkey"}),
]);

export const menuTierPrices = pgTable("menu_tier_prices", {
	tierId: uuid("tier_id").notNull(),
	effectiveFrom: date("effective_from").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	baseRatePaise: bigint("base_rate_paise", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	weddingSurchargePaise: bigint("wedding_surcharge_paise", { mode: "number" }).default(5000).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.tierId],
			foreignColumns: [menuTiers.id],
			name: "menu_tier_prices_tier_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.tierId, table.effectiveFrom], name: "menu_tier_prices_pkey"}),
	check("menu_tier_prices_base_rate_paise_check", sql`base_rate_paise > 0`),
]);

export const lockSignoffs = pgTable("lock_signoffs", {
	eventId: uuid("event_id").notNull(),
	designation: signoffRole().notNull(),
	signedBy: uuid("signed_by").notNull(),
	signedAt: timestamp("signed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.eventId],
			foreignColumns: [events.id],
			name: "lock_signoffs_event_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.signedBy],
			foreignColumns: [users.id],
			name: "lock_signoffs_signed_by_fkey"
		}),
	primaryKey({ columns: [table.eventId, table.designation], name: "lock_signoffs_pkey"}),
]);

export const subEventMenuCategories = pgTable("sub_event_menu_categories", {
	menuId: uuid("menu_id").notNull(),
	categoryName: text("category_name").notNull(),
	basePick: integer("base_pick"),
	extraPicks: integer("extra_picks").default(0).notNull(),
	exceptionId: uuid("exception_id"),
}, (table) => [
	foreignKey({
			columns: [table.menuId],
			foreignColumns: [subEventMenus.id],
			name: "sub_event_menu_categories_menu_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.exceptionId],
			foreignColumns: [exceptions.id],
			name: "semc_exception_fk"
		}).onDelete("set null"),
	primaryKey({ columns: [table.menuId, table.categoryName], name: "sub_event_menu_categories_pkey"}),
	check("sub_event_menu_categories_base_pick_check", sql`(base_pick IS NULL) OR (base_pick > 0)`),
	check("sub_event_menu_categories_check", sql`NOT ((base_pick IS NULL) AND (extra_picks > 0))`),
]);

// Chef delicacy requests: an off-menu ask the Chef prices per plate. See db/schema.sql.
export const chefRequests = pgTable("chef_requests", {
	id: uuid().default(sql`gen_random_uuid()`).primaryKey().notNull(),
	subEventId: uuid("sub_event_id").notNull(),
	description: text().notNull(),
	status: text().default('pending').notNull(),
	// bigint paise — the per-plate addition set by the Chef.
	chargePaise: bigint("charge_paise", { mode: "number" }),
	remark: text(),
	requestedBy: uuid("requested_by").notNull(),
	requestedAt: timestamp("requested_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	pricedBy: uuid("priced_by"),
	pricedAt: timestamp("priced_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("chef_requests_sub_event_idx").using("btree", table.subEventId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.subEventId],
			foreignColumns: [subEvents.id],
			name: "chef_requests_sub_event_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.requestedBy],
			foreignColumns: [users.id],
			name: "chef_requests_requested_by_fkey"
		}),
	foreignKey({
			columns: [table.pricedBy],
			foreignColumns: [users.id],
			name: "chef_requests_priced_by_fkey"
		}),
	check("chef_requests_status_chk", sql`status = ANY (ARRAY['pending'::text, 'priced'::text, 'declined'::text])`),
]);
