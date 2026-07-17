import { relations } from "drizzle-orm/relations";
import { menuCategories, menuItems, eventTypes, events, users, guestDocuments, subEvents, venues, venueBundles, subEventMenus, menuTiers, subEventAddons, exceptions, lodgingUnits, rooms, roomRequirements, roomAllocations, discounts, payments, paymentReminders, maintenanceEntries, settings, invoices, invoiceLines, auditLog, roles, properties, venueRateCards, venueBundleMembers, eventContacts, subEventMenuSelections, rolePermissions, modules, lockSignoffs, menuTierPrices, venueSlotBookings, subEventMenuCategories } from "./schema";

export const menuItemsRelations = relations(menuItems, ({one}) => ({
	menuCategory: one(menuCategories, {
		fields: [menuItems.categoryId],
		references: [menuCategories.id]
	}),
}));

export const menuCategoriesRelations = relations(menuCategories, ({one, many}) => ({
	menuItems: many(menuItems),
	subEventMenus: many(subEventMenus),
	menuTier: one(menuTiers, {
		fields: [menuCategories.tierId],
		references: [menuTiers.id]
	}),
}));

export const eventsRelations = relations(events, ({one, many}) => ({
	eventType: one(eventTypes, {
		fields: [events.eventType],
		references: [eventTypes.code]
	}),
	user_createdBy: one(users, {
		fields: [events.createdBy],
		references: [users.id],
		relationName: "events_createdBy_users_id"
	}),
	user_lockedBy: one(users, {
		fields: [events.lockedBy],
		references: [users.id],
		relationName: "events_lockedBy_users_id"
	}),
	guestDocuments: many(guestDocuments),
	subEvents: many(subEvents),
	exceptions: many(exceptions),
	roomRequirements: many(roomRequirements),
	roomAllocations: many(roomAllocations),
	discounts: many(discounts),
	payments: many(payments),
	paymentReminders: many(paymentReminders),
	maintenanceEntries: many(maintenanceEntries),
	invoices: many(invoices),
	eventContacts: many(eventContacts),
	lockSignoffs: many(lockSignoffs),
	venueSlotBookings: many(venueSlotBookings),
}));

export const eventTypesRelations = relations(eventTypes, ({many}) => ({
	events: many(events),
	venueRateCards: many(venueRateCards),
}));

export const usersRelations = relations(users, ({one, many}) => ({
	events_createdBy: many(events, {
		relationName: "events_createdBy_users_id"
	}),
	events_lockedBy: many(events, {
		relationName: "events_lockedBy_users_id"
	}),
	guestDocuments: many(guestDocuments),
	exceptions_raisedBy: many(exceptions, {
		relationName: "exceptions_raisedBy_users_id"
	}),
	exceptions_decidedBy: many(exceptions, {
		relationName: "exceptions_decidedBy_users_id"
	}),
	roomAllocations: many(roomAllocations),
	discounts: many(discounts),
	payments: many(payments),
	maintenanceEntries: many(maintenanceEntries),
	settings: many(settings),
	invoices: many(invoices),
	auditLogs: many(auditLog),
	role: one(roles, {
		fields: [users.roleId],
		references: [roles.id]
	}),
	lockSignoffs: many(lockSignoffs),
}));

export const guestDocumentsRelations = relations(guestDocuments, ({one}) => ({
	event: one(events, {
		fields: [guestDocuments.eventId],
		references: [events.id]
	}),
	user: one(users, {
		fields: [guestDocuments.uploadedBy],
		references: [users.id]
	}),
}));

export const subEventsRelations = relations(subEvents, ({one, many}) => ({
	event: one(events, {
		fields: [subEvents.eventId],
		references: [events.id]
	}),
	venue: one(venues, {
		fields: [subEvents.venueId],
		references: [venues.id]
	}),
	venueBundle: one(venueBundles, {
		fields: [subEvents.bundleId],
		references: [venueBundles.id]
	}),
	subEventMenus: many(subEventMenus),
	subEventAddons: many(subEventAddons),
	venueSlotBookings: many(venueSlotBookings),
}));

export const venuesRelations = relations(venues, ({one, many}) => ({
	subEvents: many(subEvents),
	property: one(properties, {
		fields: [venues.propertyId],
		references: [properties.id]
	}),
	venueRateCards: many(venueRateCards),
	venueBundleMembers: many(venueBundleMembers),
	venueSlotBookings: many(venueSlotBookings),
}));

export const venueBundlesRelations = relations(venueBundles, ({many}) => ({
	subEvents: many(subEvents),
	venueRateCards: many(venueRateCards),
	venueBundleMembers: many(venueBundleMembers),
}));

export const subEventMenusRelations = relations(subEventMenus, ({one, many}) => ({
	subEvent: one(subEvents, {
		fields: [subEventMenus.subEventId],
		references: [subEvents.id]
	}),
	menuTier: one(menuTiers, {
		fields: [subEventMenus.tierId],
		references: [menuTiers.id]
	}),
	menuCategory: one(menuCategories, {
		fields: [subEventMenus.freeIncreaseCategory],
		references: [menuCategories.id]
	}),
	subEventMenuSelections: many(subEventMenuSelections),
	subEventMenuCategories: many(subEventMenuCategories),
}));

export const menuTiersRelations = relations(menuTiers, ({many}) => ({
	subEventMenus: many(subEventMenus),
	menuCategories: many(menuCategories),
	menuTierPrices: many(menuTierPrices),
}));

export const subEventAddonsRelations = relations(subEventAddons, ({one}) => ({
	subEvent: one(subEvents, {
		fields: [subEventAddons.subEventId],
		references: [subEvents.id]
	}),
}));

export const exceptionsRelations = relations(exceptions, ({one, many}) => ({
	event: one(events, {
		fields: [exceptions.eventId],
		references: [events.id]
	}),
	user_raisedBy: one(users, {
		fields: [exceptions.raisedBy],
		references: [users.id],
		relationName: "exceptions_raisedBy_users_id"
	}),
	user_decidedBy: one(users, {
		fields: [exceptions.decidedBy],
		references: [users.id],
		relationName: "exceptions_decidedBy_users_id"
	}),
	discounts: many(discounts),
	subEventMenuCategories: many(subEventMenuCategories),
}));

export const roomsRelations = relations(rooms, ({one, many}) => ({
	lodgingUnit: one(lodgingUnits, {
		fields: [rooms.unitId],
		references: [lodgingUnits.id]
	}),
	roomAllocations: many(roomAllocations),
}));

export const lodgingUnitsRelations = relations(lodgingUnits, ({many}) => ({
	rooms: many(rooms),
}));

export const roomRequirementsRelations = relations(roomRequirements, ({one}) => ({
	event: one(events, {
		fields: [roomRequirements.eventId],
		references: [events.id]
	}),
}));

export const roomAllocationsRelations = relations(roomAllocations, ({one}) => ({
	event: one(events, {
		fields: [roomAllocations.eventId],
		references: [events.id]
	}),
	room: one(rooms, {
		fields: [roomAllocations.roomId],
		references: [rooms.id]
	}),
	user: one(users, {
		fields: [roomAllocations.allocatedBy],
		references: [users.id]
	}),
}));

export const discountsRelations = relations(discounts, ({one}) => ({
	event: one(events, {
		fields: [discounts.eventId],
		references: [events.id]
	}),
	exception: one(exceptions, {
		fields: [discounts.exceptionId],
		references: [exceptions.id]
	}),
	user: one(users, {
		fields: [discounts.givenBy],
		references: [users.id]
	}),
}));

export const paymentsRelations = relations(payments, ({one}) => ({
	event: one(events, {
		fields: [payments.eventId],
		references: [events.id]
	}),
	user: one(users, {
		fields: [payments.recordedBy],
		references: [users.id]
	}),
}));

export const paymentRemindersRelations = relations(paymentReminders, ({one}) => ({
	event: one(events, {
		fields: [paymentReminders.eventId],
		references: [events.id]
	}),
}));

export const maintenanceEntriesRelations = relations(maintenanceEntries, ({one}) => ({
	event: one(events, {
		fields: [maintenanceEntries.eventId],
		references: [events.id]
	}),
	user: one(users, {
		fields: [maintenanceEntries.createdBy],
		references: [users.id]
	}),
}));

export const settingsRelations = relations(settings, ({one}) => ({
	user: one(users, {
		fields: [settings.updatedBy],
		references: [users.id]
	}),
}));

export const invoicesRelations = relations(invoices, ({one, many}) => ({
	event: one(events, {
		fields: [invoices.eventId],
		references: [events.id]
	}),
	user: one(users, {
		fields: [invoices.finalisedBy],
		references: [users.id]
	}),
	invoiceLines: many(invoiceLines),
}));

export const invoiceLinesRelations = relations(invoiceLines, ({one}) => ({
	invoice: one(invoices, {
		fields: [invoiceLines.invoiceId],
		references: [invoices.id]
	}),
}));

export const auditLogRelations = relations(auditLog, ({one}) => ({
	user: one(users, {
		fields: [auditLog.userId],
		references: [users.id]
	}),
}));

export const rolesRelations = relations(roles, ({many}) => ({
	users: many(users),
	rolePermissions: many(rolePermissions),
}));

export const propertiesRelations = relations(properties, ({many}) => ({
	venues: many(venues),
}));

export const venueRateCardsRelations = relations(venueRateCards, ({one}) => ({
	venue: one(venues, {
		fields: [venueRateCards.venueId],
		references: [venues.id]
	}),
	venueBundle: one(venueBundles, {
		fields: [venueRateCards.bundleId],
		references: [venueBundles.id]
	}),
	eventType: one(eventTypes, {
		fields: [venueRateCards.eventType],
		references: [eventTypes.code]
	}),
}));

export const venueBundleMembersRelations = relations(venueBundleMembers, ({one}) => ({
	venueBundle: one(venueBundles, {
		fields: [venueBundleMembers.bundleId],
		references: [venueBundles.id]
	}),
	venue: one(venues, {
		fields: [venueBundleMembers.venueId],
		references: [venues.id]
	}),
}));

export const eventContactsRelations = relations(eventContacts, ({one}) => ({
	event: one(events, {
		fields: [eventContacts.eventId],
		references: [events.id]
	}),
}));

export const subEventMenuSelectionsRelations = relations(subEventMenuSelections, ({one}) => ({
	subEventMenu: one(subEventMenus, {
		fields: [subEventMenuSelections.menuId],
		references: [subEventMenus.id]
	}),
}));

export const rolePermissionsRelations = relations(rolePermissions, ({one}) => ({
	role: one(roles, {
		fields: [rolePermissions.roleId],
		references: [roles.id]
	}),
	module: one(modules, {
		fields: [rolePermissions.moduleCode],
		references: [modules.code]
	}),
}));

export const modulesRelations = relations(modules, ({many}) => ({
	rolePermissions: many(rolePermissions),
}));

export const lockSignoffsRelations = relations(lockSignoffs, ({one}) => ({
	event: one(events, {
		fields: [lockSignoffs.eventId],
		references: [events.id]
	}),
	user: one(users, {
		fields: [lockSignoffs.signedBy],
		references: [users.id]
	}),
}));

export const menuTierPricesRelations = relations(menuTierPrices, ({one}) => ({
	menuTier: one(menuTiers, {
		fields: [menuTierPrices.tierId],
		references: [menuTiers.id]
	}),
}));

export const venueSlotBookingsRelations = relations(venueSlotBookings, ({one}) => ({
	venue: one(venues, {
		fields: [venueSlotBookings.venueId],
		references: [venues.id]
	}),
	subEvent: one(subEvents, {
		fields: [venueSlotBookings.subEventId],
		references: [subEvents.id]
	}),
	event: one(events, {
		fields: [venueSlotBookings.eventId],
		references: [events.id]
	}),
}));

export const subEventMenuCategoriesRelations = relations(subEventMenuCategories, ({one}) => ({
	subEventMenu: one(subEventMenus, {
		fields: [subEventMenuCategories.menuId],
		references: [subEventMenus.id]
	}),
	exception: one(exceptions, {
		fields: [subEventMenuCategories.exceptionId],
		references: [exceptions.id]
	}),
}));