import { engineQueries } from '../../../database/queries';
import type { UsageSnapshot, UsageQuota } from '$shared/types/unified/engine';
import { debug } from '$shared/utils/logger';

export async function getCopilotUsage(accountId?: number): Promise<UsageSnapshot> {
	const account = accountId !== undefined
		? engineQueries.getAccount(accountId)
		: engineQueries.getActiveAccountForEngine('copilot');

	if (!account || !account.credential) {
		throw new Error('Copilot account or credential not found');
	}

	const token = account.credential;
	debug.log('engine', 'Fetching Copilot usage via internal API...');

	const response = await fetch('https://api.github.com/copilot_internal/user', {
		method: 'GET',
		headers: {
			'Authorization': `Bearer ${token}`,
			'Accept': 'application/json',
			'User-Agent': 'Clopen/1.0.0'
		}
	});

	if (response.status === 401) {
		throw new Error('Copilot token is invalid or expired (401)');
	}

	if (!response.ok) {
		throw new Error(`Copilot API request failed: HTTP ${response.status}`);
	}

	const data = (await response.json()) as any;

	const plan = data.copilot_plan || 'unknown';
	const premiumInteractions = data.quota_snapshots?.premium_interactions;

	// Case 1: Unlimited premium interactions (common for some business/enterprise tiers)
	if (premiumInteractions?.unlimited === true) {
		return {
			providerId: 'copilot',
			quotas: [{
				percentRemaining: 100,
				quotaType: 'Monthly',
				providerId: 'copilot',
				resetsAt: null,
				resetText: 'Unlimited AI credits'
			}],
			capturedAt: new Date().toISOString(),
			accountEmail: plan
		};
	}

	// Case 2: Regular user with quotas
	if (premiumInteractions) {
		const entitlement = premiumInteractions.entitlement ?? 0;
		const remaining = premiumInteractions.remaining ?? 0;
		const percentRemaining = premiumInteractions.percent_remaining ?? 100;
		const used = Math.max(0, entitlement - remaining);

		return {
			providerId: 'copilot',
			quotas: [{
				percentRemaining,
				quotaType: 'Monthly',
				providerId: 'copilot',
				resetsAt: null, // resets monthly
				resetText: `${used} / ${entitlement} AI credits`
			}],
			capturedAt: new Date().toISOString(),
			accountEmail: plan
		};
	}

	// Case 3: Fallback if no premium interactions object exists
	return {
		providerId: 'copilot',
		quotas: [{
			percentRemaining: 100,
			quotaType: 'Monthly',
			providerId: 'copilot',
			resetsAt: null,
			resetText: 'No AI credits quota'
		}],
		capturedAt: new Date().toISOString(),
		accountEmail: plan
	};
}
