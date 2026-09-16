/**
 * db-client — account-backed connections.
 *
 * A connection can arrive two ways: typed into the form, or DERIVED from a
 * connected third-party account. The second kind is a projection (see
 * `backend/integrations/projections/`), and everything here is the vocabulary
 * the panel needs to render one honestly: who owns it, which remote database it
 * points at, and what the form is therefore not allowed to edit.
 */

import type { DbDriver } from './connection';

/**
 * How the connection reaches the database.
 *
 * A managed provider usually offers a pooled endpoint and a direct one. The
 * trade-offs are real, but they are NOT a choice most users should be asked to
 * make: for every provider so far exactly one mode is correct for a client like
 * this, and the others exist for cases the default cannot reach.
 *
 * So `isDefault` is picked silently and `isAdvanced` marks the escape hatches,
 * which the dialog keeps folded away. A form that opens with three radio
 * buttons and three paragraphs asks the user to decide something they have no
 * way to decide, before they have connected anything.
 */
export interface DbConnectionModeInfo {
	id: string;
	label: string;
	help: string;
	/** Chosen without asking when the user has expressed no preference. */
	isDefault?: boolean;
	/** Hidden behind the dialog's Advanced disclosure. */
	isAdvanced?: boolean;
}

/** One secret a link needs that the provider's API will not hand back. */
export interface DbLinkSecretField {
	name: string;
	label: string;
	placeholder?: string;
	help?: string;
	isRequired: boolean;
}

/** A database provider as the link dialog renders it. */
export interface DbProviderInfo {
	/** Matches the integration provider id, so the brand mark is the same one. */
	id: string;
	name: string;
	driver: DbDriver;
	modes: DbConnectionModeInfo[];
	secretFields: DbLinkSecretField[];
	/** Copy shown above the picker — where to find things, what will happen. */
	description: string;
}

/** A remote database an account can reach but has not necessarily linked. */
export interface DbRemoteDatabase {
	ref: string;
	name: string;
	/** Region, plan — whatever tells two similarly named databases apart. */
	detail: string | null;
	/**
	 * The owning container's name — Supabase's organisation, Turso's group.
	 *
	 * Separate from `detail` because it answers a different question: `detail`
	 * tells two similar rows apart, this one says which of the account's
	 * organisations will be billed for the row you are about to link.
	 */
	group: string | null;
	/** Provider-reported state; a paused project cannot be connected to. */
	status: string | null;
	/**
	 * Whether it can be connected to right now.
	 *
	 * The ADAPTER decides, because "ready" is provider vocabulary: Supabase says
	 * `ACTIVE_HEALTHY`, and a project that is still coming up reports a state
	 * that looks fine in a list and refuses every connection.
	 */
	isReady: boolean;
	/** True when this account already projects a connection for it. */
	isLinked: boolean;
}

/**
 * What the create-a-database form needs, fetched from the provider.
 *
 * Provider-agnostic on purpose even though Supabase is the only implementation:
 * every managed provider asks the same two questions — which account or
 * organisation owns it, and where it should live — and they only differ in what
 * those are called. Neon calls them projects and regions, Turso calls them
 * groups and locations.
 */
/**
 * One container a database could be created in.
 *
 * `isUnverified` is the honest middle ground between hiding a candidate and
 * vouching for it. A token can be allowed to CREATE an organisation while being
 * unable to READ one — they are separate permissions — so "we could not confirm
 * this" is a real third state, and removing those options altogether took away
 * a capability that may well work.
 */
export interface DbProviderCreateGroup {
	value: string;
	label: string;
	detail?: string | null;
	/** True when the provider would not confirm this token can act in it. */
	isUnverified?: boolean;
}

export interface DbProviderCreateOptions {
	/** What the owning container is called here — "Organisation", "Team". */
	groupLabel: string;
	groups: DbProviderCreateGroup[];
	regionLabel: string;
	regions: { value: string; label: string }[];
	/** One sentence naming what creating one actually costs. */
	notice: string;
	/** Shown instead of the form when `groups` is empty, naming the real cause. */
	emptyGroupsNotice: string;
	/** True when the provider can create the owning container from here too. */
	canCreateGroup: boolean;
	/** One sentence naming what creating a container costs. */
	createGroupNotice: string;
}

/** A link, as the panel sees it. Secret VALUES never cross this line. */
export interface DbAccountLinkInfo {
	id: string;
	accountId: string;
	provider: string;
	accountLabel: string;
	remoteRef: string;
	label: string;
	driver: DbDriver;
	mode: string;
	/** The projected connection, or null when projection has not run yet. */
	connectionId: string | null;
	/** Which secret fields hold a value — never what they hold. */
	configuredSecrets: string[];
	detected: boolean;
}

/**
 * Stamped onto a connection the panel did not create.
 *
 * Its presence is what makes the form read-only: the fields it describes are
 * derived from the account, and editing them locally would produce a row that
 * the next re-projection silently overwrites.
 */
export interface DbClientManagedBy {
	accountId: string;
	provider: string;
	providerName: string;
	accountLabel: string;
	linkId: string | null;
	remoteRef: string | null;
	/**
	 * True when the row existed before the account did. The panel says so,
	 * because disconnecting will hand it back rather than delete it.
	 */
	adopted: boolean;
}

/** What DB Client knows about a Supabase-shaped connection. */
export interface SupabaseConnectionContext {
	/** Project ref. Present for a linked project AND for a detected local stack. */
	ref: string;
	/** Null for a local stack with no connected account — API features are off. */
	accountId: string | null;
	projectName: string | null;
	/** True when this is a `supabase start` stack on this machine. */
	isLocal: boolean;
}
