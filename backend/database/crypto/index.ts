/**
 * Secrets at rest.
 *
 * `envelope.ts`       — AES-256-GCM seal/open, prefixed and fingerprinted.
 * `master-key.ts`     — where the key comes from, and the threat model.
 * `secret-columns.ts` — which columns are secret, plus the plaintext audit.
 */

export { isSealed, seal, open, getDecryptFailures, resetDecryptFailures } from './envelope';
export type { DecryptFailureState } from './envelope';
export { getMasterKey, resetMasterKeyCache } from './master-key';
export type { MasterKey } from './master-key';
export {
	SECRET_COLUMNS,
	secretColumnsOf,
	openRow,
	openRows,
	sealFor,
	auditSecretColumns,
	logSecretColumnAudit
} from './secret-columns';
export type { SecretColumnAudit } from './secret-columns';
