/**
 * Git identities — shared vocabulary between the server and the UI.
 *
 * An identity answers two questions a git command asks: who authored this, and
 * what proves I may push it. The first half (`name`, `email`) is attribution;
 * the second (`authMethod` and whichever credential it names) is access. They
 * live together because a user thinks of them as one account — "my work
 * GitHub" — even though git keeps them in completely different places.
 *
 * NOTHING SECRET CROSSES THIS LINE. The private key, its passphrase, and the
 * HTTPS token are sealed on the row and never serialised to a client; the DTO
 * carries only whether each is set. The public key is the exception, and is
 * public by definition — the UI needs it so the user can paste it into GitHub.
 */

/** How an identity proves itself to a remote. */
export type GitIdentityAuthMethod =
	/** Attribution only — pushing falls back to whatever the machine provides. */
	| 'none'
	/** An SSH private key, stored here and written to disk for `ssh -i`. */
	| 'ssh-key'
	/** A token typed into Clopen, served over the git credential protocol. */
	| 'https-token'
	/** A token borrowed from an already-connected integration account. */
	| 'https-account';

/**
 * Where an identity came from.
 *
 * `local-machine` is the one mirrored from `git config --global`. It is editable
 * but not deletable — the machine's config is what it reflects, so removing the
 * row would only make it come back.
 */
export type GitIdentitySource = 'manual' | 'local-machine';

/** An identity as the client sees it — credentials reduced to presence flags. */
export interface GitIdentityDTO {
	id: string;
	/** What the user calls this account: "Work", "Personal". */
	label: string;
	/** `user.name`. */
	name: string;
	/** `user.email`. */
	email: string;
	authMethod: GitIdentityAuthMethod;
	/**
	 * Hostnames this identity's credential is valid for, lowercased
	 * (`["github.com"]`). Empty means the identity makes no host claim: it can
	 * still author commits, but is never chosen to authenticate a remote.
	 */
	hosts: string[];
	/** Public half of the SSH key, for copying into the host's settings. */
	sshPublicKey: string | null;
	/** True when a private key is stored. The key itself never leaves the server. */
	hasSshKey: boolean;
	/** True when that key needs a passphrase to use. */
	hasSshPassphrase: boolean;
	/** True when an HTTPS token is stored. */
	hasHttpsToken: boolean;
	/** Username sent alongside the HTTPS token. */
	httpsUsername: string | null;
	/** The borrowed integration account, when `authMethod` is `https-account`. */
	integrationAccountId: string | null;
	/** Used when a project names no identity of its own. */
	isDefault: boolean;
	source: GitIdentitySource;
	/** False for the mirrored machine identity — see {@link GitIdentitySource}. */
	canDelete: boolean;
	createdAt: string;
	updatedAt: string;
}

/** Fields a create/update accepts. Secrets are write-only and omitted to keep. */
export interface GitIdentityInput {
	label: string;
	name: string;
	email: string;
	authMethod: GitIdentityAuthMethod;
	hosts: string[];
	/** PEM private key. `null` clears it; omitted leaves the stored one alone. */
	sshPrivateKey?: string | null;
	sshPublicKey?: string | null;
	sshPassphrase?: string | null;
	httpsUsername?: string | null;
	httpsToken?: string | null;
	integrationAccountId?: string | null;
	isDefault?: boolean;
}

/**
 * Which identity a git command actually ran as, and why.
 *
 * `source` is what the UI shows so a user can tell an inherited identity from a
 * chosen one before they commit, rather than after they push.
 */
export interface ResolvedGitIdentity {
	identity: GitIdentityDTO | null;
	source: 'project' | 'user-default' | 'none';
	/**
	 * The identity supplying credentials for a given remote host, when the
	 * project's own identity does not claim that host. Null when the project
	 * identity covers it, or when nothing does.
	 */
	credentialIdentity: GitIdentityDTO | null;
}

/** An SSH keypair generated on the server. The private half is stored, not returned. */
export interface GeneratedSshKey {
	publicKey: string;
	/** Fingerprint for display, so the user can match it against the host. */
	fingerprint: string;
}
