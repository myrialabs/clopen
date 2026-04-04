/**
 * Tunnel Config Manager
 *
 * Manages Cloudflare Tunnel configurations:
 * - Remote (dashboard-managed): token + label
 * - Local (locally-managed): tunnel name, ID, credentials, ingress rules
 *
 * Config stored in ~/.clopen/tunnel/config.json
 */

import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { getClopenDir } from '../utils/paths';
import { debug } from '$shared/utils/logger';
import { randomUUID } from 'crypto';

// --- Types ---

export interface RemoteTunnelConfig {
	id: string;
	label: string;
	token: string;
}

export interface LocalTunnelIngressRule {
	hostname: string;
	service: string;
}

export interface LocalTunnelConfig {
	id: string;
	name: string;
	tunnelId: string;
	credentialsFile: string;
	ingress: LocalTunnelIngressRule[];
}

interface TunnelConfigFile {
	remotes: RemoteTunnelConfig[];
	locals: LocalTunnelConfig[];
	authorizedZone?: string;
}

// --- Paths ---

const TUNNEL_DIR = join(getClopenDir(), 'tunnel');
const CONFIG_FILE = join(TUNNEL_DIR, 'config.json');

export function getTunnelDir(): string {
	return TUNNEL_DIR;
}

// --- Internal helpers ---

function ensureDir(): void {
	if (!existsSync(TUNNEL_DIR)) {
		mkdirSync(TUNNEL_DIR, { recursive: true });
	}
}

function readConfigFile(): TunnelConfigFile {
	try {
		if (!existsSync(CONFIG_FILE)) {
			return { remotes: [], locals: [] };
		}
		const raw = readFileSync(CONFIG_FILE, 'utf-8');
		const data = JSON.parse(raw);

		// Migration: old format { configs: [{ id, token, domain }] }
		if (data.configs && !data.remotes) {
			const migrated: TunnelConfigFile = {
				remotes: data.configs.map((c: { id: string; token: string; domain: string }) => ({
					id: c.id,
					label: c.domain,
					token: c.token
				})),
				locals: []
			};
			writeConfigFile(migrated);
			debug.log('tunnel', 'Migrated old tunnel config to remote/local format');
			return migrated;
		}

		// Migration: single entry format { token, domain }
		if (data.token && data.domain && !data.remotes && !data.configs) {
			const migrated: TunnelConfigFile = {
				remotes: [{ id: randomUUID(), label: data.domain, token: data.token }],
				locals: []
			};
			writeConfigFile(migrated);
			debug.log('tunnel', 'Migrated single tunnel config to remote/local format');
			return migrated;
		}

		return {
			remotes: data.remotes ?? [],
			locals: data.locals ?? [],
			authorizedZone: data.authorizedZone
		};
	} catch (error) {
		debug.error('tunnel', 'Failed to read tunnel config:', error);
		return { remotes: [], locals: [] };
	}
}

function writeConfigFile(data: TunnelConfigFile): void {
	ensureDir();
	writeFileSync(CONFIG_FILE, JSON.stringify(data, null, '\t'), 'utf-8');
}

// --- Remote tunnel config ---

export function getRemoteTunnelConfigs(): RemoteTunnelConfig[] {
	return readConfigFile().remotes;
}

export function getRemoteTunnelConfigById(id: string): RemoteTunnelConfig | null {
	return readConfigFile().remotes.find((c) => c.id === id) ?? null;
}

export function addRemoteTunnelConfig(label: string, token: string): RemoteTunnelConfig {
	const data = readConfigFile();
	const entry: RemoteTunnelConfig = { id: randomUUID(), label, token };
	data.remotes.push(entry);
	writeConfigFile(data);
	debug.log('tunnel', `Remote tunnel config added: ${label}`);
	return entry;
}

export function removeRemoteTunnelConfig(id: string): boolean {
	const data = readConfigFile();
	const before = data.remotes.length;
	data.remotes = data.remotes.filter((c) => c.id !== id);
	if (data.remotes.length < before) {
		writeConfigFile(data);
		debug.log('tunnel', `Remote tunnel config removed: ${id}`);
		return true;
	}
	return false;
}

// --- Local tunnel config ---

export function getLocalTunnelConfigs(): LocalTunnelConfig[] {
	return readConfigFile().locals;
}

export function getLocalTunnelConfigById(id: string): LocalTunnelConfig | null {
	return readConfigFile().locals.find((c) => c.id === id) ?? null;
}

export function addLocalTunnelConfig(
	name: string,
	tunnelId: string,
	credentialsFile: string
): LocalTunnelConfig {
	const data = readConfigFile();
	const entry: LocalTunnelConfig = {
		id: randomUUID(),
		name,
		tunnelId,
		credentialsFile,
		ingress: []
	};
	data.locals.push(entry);
	writeConfigFile(data);
	debug.log('tunnel', `Local tunnel config added: ${name} (${tunnelId})`);
	return entry;
}

export function removeLocalTunnelConfig(id: string): boolean {
	const data = readConfigFile();
	const before = data.locals.length;
	data.locals = data.locals.filter((c) => c.id !== id);
	if (data.locals.length < before) {
		writeConfigFile(data);
		debug.log('tunnel', `Local tunnel config removed: ${id}`);
		return true;
	}
	return false;
}

export function addLocalTunnelIngress(
	id: string,
	hostname: string,
	service: string
): LocalTunnelConfig | null {
	const data = readConfigFile();
	const config = data.locals.find((c) => c.id === id);
	if (!config) return null;

	// Update existing or add new
	const existing = config.ingress.findIndex((r) => r.hostname === hostname);
	if (existing >= 0) {
		config.ingress[existing].service = service;
	} else {
		config.ingress.push({ hostname, service });
	}

	writeConfigFile(data);
	debug.log('tunnel', `Ingress rule added/updated for ${config.name}: ${hostname} -> ${service}`);
	return config;
}

export function removeLocalTunnelIngress(id: string, hostname: string): LocalTunnelConfig | null {
	const data = readConfigFile();
	const config = data.locals.find((c) => c.id === id);
	if (!config) return null;

	config.ingress = config.ingress.filter((r) => r.hostname !== hostname);
	writeConfigFile(data);
	debug.log('tunnel', `Ingress rule removed for ${config.name}: ${hostname}`);
	return config;
}

// --- Authorized zone ---

export function getAuthorizedZone(): string | null {
	return readConfigFile().authorizedZone ?? null;
}

export function setAuthorizedZone(zone: string): void {
	const data = readConfigFile();
	data.authorizedZone = zone;
	writeConfigFile(data);
	debug.log('tunnel', `Authorized zone set: ${zone}`);
}

export function clearAuthorizedZone(): void {
	const data = readConfigFile();
	delete data.authorizedZone;
	writeConfigFile(data);
	debug.log('tunnel', 'Authorized zone cleared');
}
