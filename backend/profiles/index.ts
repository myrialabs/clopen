/**
 * Profiles — reusable artifact bundles activated per-session.
 *
 * Public facade: the service (CRUD + inventory for Settings) plus the two pure
 * resolution helpers the stream path calls to scope artifacts to the active
 * profile. See `service.ts` for the design.
 */

export { profileService, resolveActiveProfileId, artifactFilter } from './service';
export type { ProfileDTO, ProfileInventory, ProfileInventoryEntry } from './service';
