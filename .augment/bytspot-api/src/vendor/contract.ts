import bookableTemplates from './contracts/bookable-templates.json';
import vendorConsole from './contracts/vendor-console.json';

/**
 * The vendor contracts, copied from bytspot-beta.
 *
 * Copied rather than imported: the console and the API deploy separately, so a
 * runtime dependency between them would mean neither could ship alone. This is
 * the same trade the iOS bundle already makes with its own copy of
 * bookable-templates.json.
 *
 * The copies must be re-copied when the originals move. `contractsAreCurrent`
 * pins the versions so a stale copy fails a test rather than serving a state
 * machine the console no longer believes in.
 */
export const BOOKABLE_TEMPLATES = bookableTemplates;
export const VENDOR_CONSOLE = vendorConsole;

export const CONTRACT_VERSIONS = {
  bookableTemplates: bookableTemplates.version,
  vendorConsole: vendorConsole.version,
} as const;

export type SellerState = 'DRAFT' | 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
export type SeatState = 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
export type SeatRole = 'owner' | 'manager' | 'staff' | 'door' | 'serviceProvider';
export type StaffScope = 'all' | 'assigned';

const seller = bookableTemplates.seller as {
  identity: {
    states: SellerState[];
    transitions: { from: SellerState; to: SellerState[] }[];
    consoleStates: SellerState[];
    publishableStates: SellerState[];
    requirements: { id: string; label: string; blocks: SellerState }[];
    stateCapabilities: { state: SellerState; allows: string[] }[];
  };
  seats: { states: SeatState[] };
};

const staffRoles = bookableTemplates.staffRoles as {
  id: SeatRole;
  scope: StaffScope;
  capabilities: string[];
}[];

/** Auth numbers the client also reads, so both ends agree on one source. */
export const AUTH = (vendorConsole as { auth: {
  code: { length: number; ttlSecs: number; maxAttempts: number; resendCooldownSecs: number };
  token: { accessTtlSecs: number; refreshTtlSecs: number };
} }).auth;

/** Requirement ids in catalog order, so a checklist reads the same everywhere. */
export function sellerRequirements(): { id: string; label: string; blocks: SellerState }[] {
  return seller.identity.requirements;
}

function lifecycleRank(state: SellerState): number {
  const index = seller.identity.states.indexOf(state);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

/**
 * Requirements a seller in this state must already have met.
 *
 * `blocks` names the state a requirement gates reaching, so everything gating
 * this state or an earlier one is owed. A business that reached ACTIVE owes the
 * PENDING requirements too, which is what makes a lapsed one detectable rather
 * than merely incomplete.
 */
export function requirementsForState(state: SellerState): string[] {
  const reached = lifecycleRank(state);
  return seller.identity.requirements
    .filter((requirement) => lifecycleRank(requirement.blocks) <= reached)
    .map((requirement) => requirement.id);
}

export function sellerCanUseConsole(state: SellerState): boolean {
  return seller.identity.consoleStates.includes(state);
}

export function sellerCanTransition(from: SellerState, to: SellerState): boolean {
  return seller.identity.transitions.find((entry) => entry.from === from)?.to.includes(to) ?? false;
}

export function roleCapabilities(role: SeatRole): string[] {
  return staffRoles.find((entry) => entry.id === role)?.capabilities ?? [];
}

export function roleScope(role: SeatRole): StaffScope {
  return staffRoles.find((entry) => entry.id === role)?.scope ?? 'assigned';
}

/**
 * The ceiling a seller's own state puts on every seat inside it. A suspended
 * business still honours what it already sold, so CHECK_IN, VERIFY, CANCEL and
 * REFUND survive suspension while SELL and PUBLISH do not.
 */
export function stateAllows(state: SellerState): string[] {
  return seller.identity.stateCapabilities.find((entry) => entry.state === state)?.allows ?? [];
}

/**
 * What a seat may actually do: its role narrowed by the business's own state.
 * Never the role's list on its own — that would let a suspended business keep
 * selling because the person in the chair is still an owner.
 */
export function effectiveCapabilities(role: SeatRole, state: SellerState): string[] {
  const ceiling = new Set(stateAllows(state));
  return roleCapabilities(role).filter((capability) => ceiling.has(capability));
}

/* ── Locations ─────────────────────────────────────────────────────────── */

export type LocationState = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'CLOSED';
export type LocationKindId = 'fixed' | 'zone' | 'mobile' | 'visiting';
export type LocationOperationId = 'ACTIVATE_LOCATION' | 'PAUSE_LOCATION' | 'CLOSE_LOCATION';
export type Fulfillment = 'guestTravels' | 'vendorTravels';

const locations = (bookableTemplates as {
  locations: {
    kinds: { id: LocationKindId; fulfillment: Fulfillment; requiresAddress: boolean; requiresRadius: boolean }[];
    states: LocationState[];
    publishableStates: LocationState[];
    operations: { id: LocationOperationId; from: LocationState[]; to: LocationState; requiresCapability: string }[];
    defaults: { kind: LocationKindId; radiusMiles: number; maxRadiusMiles: number };
  };
}).locations;

export const LOCATION_DEFAULTS = locations.defaults;

export function locationKind(kind: LocationKindId) {
  return locations.kinds.find((entry) => entry.id === kind);
}

export function locationCanPublish(state: LocationState): boolean {
  return locations.publishableStates.includes(state);
}

/**
 * The operation a vendor pressed, resolved against the catalog.
 *
 * The console sends the operation rather than the state to land in, so this is
 * the only place a transition is decided. A client posting a target state would
 * be asserting a transition is legal instead of asking.
 */
export function locationOperation(id: LocationOperationId) {
  return locations.operations.find((entry) => entry.id === id);
}
