/**
 * Tunnel Config Store
 * Manages Cloudflare Tunnel configurations (remote + local)
 */

import { debug } from '$shared/utils/logger';
import ws from '$frontend/utils/ws';

// --- Remote (dashboard-managed) ---

export interface RemoteIngressRule {
	hostname?: string;
	service: string;
}

export interface RemoteConfigItem {
	id: string;
	label: string;
	isActive: boolean;
	ingress: RemoteIngressRule[];
}

// --- Local (locally-managed) ---

export interface LocalTunnelIngressRule {
	hostname: string;
	service: string;
}

export interface LocalConfigItem {
	id: string;
	name: string;
	tunnelId: string;
	ingress: LocalTunnelIngressRule[];
	isActive: boolean;
}

// --- State ---

interface TunnelConfigState {
	remotes: RemoteConfigItem[];
	locals: LocalConfigItem[];
	isLoading: boolean;
	isSaving: boolean;
	error: string | null;
}

const state = $state<TunnelConfigState>({
	remotes: [],
	locals: [],
	isLoading: false,
	isSaving: false,
	error: null
});

export const tunnelConfigStore = {
	get remotes() { return state.remotes; },
	get hasRemotes() { return state.remotes.length > 0; },
	get locals() { return state.locals; },
	get hasLocals() { return state.locals.length > 0; },
	get isLoading() { return state.isLoading; },
	get isSaving() { return state.isSaving; },
	get error() { return state.error; },

	// --- Remote ---

	async refreshRemotes() {
		state.isLoading = true;
		state.error = null;
		try {
			const result = await ws.http('tunnel:remote:config:list', {});
			state.remotes = result.configs ?? [];
		} catch (error) {
			debug.error('tunnel', 'Failed to load remote configs:', error);
			state.error = error instanceof Error ? error.message : 'Failed to load configs';
		}
		state.isLoading = false;
	},

	async addRemote(label: string, token: string) {
		state.isSaving = true;
		state.error = null;
		try {
			const result = await ws.http('tunnel:remote:config:add', { label, token });
			state.remotes.push({ id: result.id, label: result.label, isActive: false, ingress: [] });
		} catch (error) {
			debug.error('tunnel', 'Failed to add remote config:', error);
			state.error = error instanceof Error ? error.message : 'Failed to add config';
			throw error;
		}
		state.isSaving = false;
	},

	async removeRemote(id: string) {
		state.isSaving = true;
		state.error = null;
		try {
			await ws.http('tunnel:remote:config:remove', { id });
			state.remotes = state.remotes.filter((c) => c.id !== id);
		} catch (error) {
			debug.error('tunnel', 'Failed to remove remote config:', error);
			state.error = error instanceof Error ? error.message : 'Failed to remove config';
			throw error;
		}
		state.isSaving = false;
	},

	setRemoteActive(id: string, isActive: boolean) {
		const item = state.remotes.find((c) => c.id === id);
		if (item) item.isActive = isActive;
	},

	updateRemoteIngress(id: string, ingress: RemoteIngressRule[]) {
		const item = state.remotes.find((c) => c.id === id);
		if (item) item.ingress = ingress;
	},

	// --- Local ---

	async refreshLocals() {
		state.isLoading = true;
		state.error = null;
		try {
			const result = await ws.http('tunnel:local:config:list', {});
			state.locals = result.configs ?? [];
		} catch (error) {
			debug.error('tunnel', 'Failed to load local configs:', error);
			state.error = error instanceof Error ? error.message : 'Failed to load configs';
		}
		state.isLoading = false;
	},

	async createLocal(name: string) {
		state.isSaving = true;
		state.error = null;
		try {
			const result = await ws.http('tunnel:local:create', { name });
			state.locals.push({
				id: result.id,
				name: result.name,
				tunnelId: result.tunnelId,
				ingress: [],
				isActive: false
			});
			return result;
		} catch (error) {
			debug.error('tunnel', 'Failed to create local tunnel:', error);
			state.error = error instanceof Error ? error.message : 'Failed to create tunnel';
			throw error;
		} finally {
			state.isSaving = false;
		}
	},

	async deleteLocal(id: string) {
		state.isSaving = true;
		state.error = null;
		try {
			await ws.http('tunnel:local:delete', { id });
			state.locals = state.locals.filter((c) => c.id !== id);
		} catch (error) {
			debug.error('tunnel', 'Failed to delete local tunnel:', error);
			state.error = error instanceof Error ? error.message : 'Failed to delete tunnel';
			throw error;
		} finally {
			state.isSaving = false;
		}
	},

	async addIngress(id: string, hostname: string, service: string): Promise<{ dnsRouted: boolean; dnsError: string | null }> {
		state.error = null;
		try {
			const result = await ws.http('tunnel:local:ingress:add', { id, hostname, service });
			const config = state.locals.find((c) => c.id === id);
			if (config) config.ingress = result.ingress;
			return { dnsRouted: result.dnsRouted ?? false, dnsError: result.dnsError ?? null };
		} catch (error) {
			debug.error('tunnel', 'Failed to add subdomain:', error);
			state.error = error instanceof Error ? error.message : 'Failed to add subdomain';
			throw error;
		}
	},

	async removeIngress(id: string, hostname: string) {
		state.error = null;
		try {
			const result = await ws.http('tunnel:local:ingress:remove', { id, hostname });
			const config = state.locals.find((c) => c.id === id);
			if (config) config.ingress = result.ingress;
		} catch (error) {
			debug.error('tunnel', 'Failed to remove domain:', error);
			state.error = error instanceof Error ? error.message : 'Failed to remove domain';
			throw error;
		}
	},

	setLocalActive(id: string, isActive: boolean) {
		const item = state.locals.find((c) => c.id === id);
		if (item) item.isActive = isActive;
	},

	async refresh() {
		await Promise.all([this.refreshRemotes(), this.refreshLocals()]);
	}
};
