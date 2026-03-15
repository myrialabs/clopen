/**
 * Dynamic Data Masking Store - Svelte 5 Runes
 *
 * Client-side only — does NOT modify database data.
 * Masks column values in Browse view purely for display purposes.
 */

import { dbManagerState } from './db-manager.svelte';

export type MaskMethod = 'partial' | 'stars' | 'random';

export interface MaskRule {
	column: string;
	method: MaskMethod;
	enabled: boolean;
}

// ─── State ────────────────────────────────────────────────────────────────────

export const maskingState = $state({
	showModal: false,
	// Key: `${connectionId}::${schema ?? ''}::${tableName}`
	rules: {} as Record<string, MaskRule[]>
});

// ─── Key helper ───────────────────────────────────────────────────────────────

function tableKey(): string | null {
	const { activeConnectionId, activeTableName, activeTableSchema } = dbManagerState;
	if (!activeConnectionId || !activeTableName) return null;
	return `${activeConnectionId}::${activeTableSchema ?? ''}::${activeTableName}`;
}

// ─── Rule accessors ───────────────────────────────────────────────────────────

export function getActiveMaskRules(): MaskRule[] {
	const key = tableKey();
	if (!key) return [];
	return maskingState.rules[key] ?? [];
}

export function setMaskRule(column: string, method: MaskMethod, enabled: boolean): void {
	const key = tableKey();
	if (!key) return;
	const existing = maskingState.rules[key] ?? [];
	const idx = existing.findIndex((r) => r.column === column);
	if (idx >= 0) {
		const updated = [...existing];
		updated[idx] = { column, method, enabled };
		maskingState.rules = { ...maskingState.rules, [key]: updated };
	} else {
		maskingState.rules = { ...maskingState.rules, [key]: [...existing, { column, method, enabled }] };
	}
}

export function removeMaskRule(column: string): void {
	const key = tableKey();
	if (!key) return;
	const existing = maskingState.rules[key] ?? [];
	maskingState.rules = { ...maskingState.rules, [key]: existing.filter((r) => r.column !== column) };
}

export function clearAllMaskRules(): void {
	const key = tableKey();
	if (!key) return;
	maskingState.rules = { ...maskingState.rules, [key]: [] };
}

export function openMaskingModal(): void {
	maskingState.showModal = true;
}

export function closeMaskingModal(): void {
	maskingState.showModal = false;
}

// ─── Masking functions ────────────────────────────────────────────────────────

/** Deterministic hash — keeps random masking stable across renders */
function strHash(s: string, index: number): number {
	let h = 0;
	for (let i = 0; i < s.length; i++) {
		h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
	}
	return Math.abs((Math.imul(31, h) + index) | 0);
}

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const DIGITS = '0123456789';

function seededChar(seed: string, index: number, isDigit: boolean): string {
	const hash = strHash(seed, index);
	if (isDigit) return DIGITS[hash % DIGITS.length];
	return LOWER[hash % LOWER.length];
}

/**
 * Apply a masking method to a display string.
 * Never called with null/undefined — caller must guard.
 */
export function applyMask(value: string, method: MaskMethod): string {
	if (!value) return value;
	switch (method) {
		case 'stars':
			return '***';

		case 'partial': {
			if (value.includes('@')) {
				// Email: j***@example.com
				const atIdx = value.indexOf('@');
				const local = value.slice(0, atIdx);
				const domain = value.slice(atIdx);
				return `${local[0] ?? '*'}***${domain}`;
			}
			// General: first char + *** + last char
			if (value.length <= 2) return `${value[0]}***`;
			return `${value[0]}***${value[value.length - 1]}`;
		}

		case 'random':
			// Replace alphanumerics with seeded-random chars (preserves structure like @, -, .)
			return value
				.split('')
				.map((c, i) => {
					if (/\d/.test(c)) return seededChar(value, i, true);
					if (/[a-zA-Z]/.test(c)) return seededChar(value, i, false);
					return c;
				})
				.join('');

		default:
			return value;
	}
}
