/**
 * Inbound event gateway.
 *
 * ONE unauthenticated endpoint, `/api/integrations/hooks/<provider>`. Treat it
 * as a new attack surface, because it is: it is the only route in Clopen that
 * anyone on the internet can reach without a session.
 *
 * Deny by default. Every rejection answers 404 — for an unknown provider, for a
 * provider nobody has connected, and for one that is disabled — so an
 * unauthenticated caller cannot use response codes to enumerate what this
 * install has connected. The body cap is applied BEFORE parsing, the signature
 * is computed over raw bytes, and replay rejection is a unique-constraint
 * insert rather than a read-then-write.
 *
 * It ships with no subscriber. Registering one is `Task 7`'s job; until then a
 * verified delivery is accepted, counted and dropped.
 */

import { integrationAccountQueries, integrationWebhookQueries } from '$backend/database/queries';
import { getProvider } from '../registry';
import { verifySignature } from './verify';
import { debug } from '$shared/utils/logger';

/** Applied before anything reads the body. A signature check on 50 MB is still 50 MB. */
export const MAX_BODY_BYTES = 1024 * 1024;

/** Per-provider window. Generous enough for a busy repo, small enough to be a limit. */
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 120;

/** Delivery ids older than this are pruned — replay protection does not need history. */
const DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface WebhookEvent {
	provider: string;
	accountId: string;
	deliveryId: string;
	headers: Headers;
	/** Parsed body. Parsing happens only AFTER the signature is verified. */
	payload: unknown;
	rawBody: Uint8Array;
}

export type WebhookSubscriber = (event: WebhookEvent) => void | Promise<void>;

const subscribers = new Map<string, WebhookSubscriber[]>();

/** Subscribe to verified deliveries for one provider. */
export function onWebhook(provider: string, subscriber: WebhookSubscriber): void {
	const list = subscribers.get(provider) ?? [];
	list.push(subscriber);
	subscribers.set(provider, list);
}

const rateWindows = new Map<string, { count: number; resetAt: number }>();

function rateLimited(provider: string): boolean {
	const now = Date.now();
	const window = rateWindows.get(provider);

	if (!window || now >= window.resetAt) {
		rateWindows.set(provider, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
		return false;
	}
	window.count += 1;
	return window.count > RATE_LIMIT_MAX;
}

let lastPruneAt = 0;

function pruneDeliveriesOccasionally(): void {
	const now = Date.now();
	if (now - lastPruneAt < DELIVERY_RETENTION_MS / 24) return;
	lastPruneAt = now;
	integrationWebhookQueries.pruneBefore(new Date(now - DELIVERY_RETENTION_MS).toISOString());
}

/**
 * Every rejection logs and answers 404.
 *
 * The status is deliberately uniform. A 401 would confirm the provider is
 * connected, a 400 would confirm the signature header shape — both are free
 * reconnaissance for something that costs us nothing to withhold.
 */
function reject(provider: string, reason: string): Response {
	debug.warn('integrations', `Rejected inbound ${provider} delivery: ${reason}`);
	return new Response('Not found', { status: 404 });
}

/**
 * Handle one inbound delivery.
 *
 * `rawBody` must be the untouched request bytes — see `verify.ts` for why.
 */
export async function handleInboundDelivery(
	providerId: string,
	rawBody: Uint8Array,
	headers: Headers
): Promise<Response> {
	const provider = getProvider(providerId);
	if (!provider?.webhook) return reject(providerId, 'unknown provider or no webhook spec');

	if (rateLimited(providerId)) return reject(providerId, 'rate limit exceeded');

	// Every enabled account for this provider that opted into inbound events.
	// More than one is legitimate: two projects, two orgs, one endpoint.
	const accounts = integrationAccountQueries
		.getEnabledForProvider(providerId)
		.filter((row) => integrationAccountQueries.capabilitiesOf(row).includes('inbound-events'));

	if (accounts.length === 0) return reject(providerId, 'no enabled account accepts inbound events');

	const spec = provider.webhook;
	const matched = accounts.find((account) => {
		const secret = integrationAccountQueries.credentialsOf(account)[spec.secretField] ?? '';
		return verifySignature(spec, secret, rawBody, headers).ok;
	});

	if (!matched) return reject(providerId, 'no connected account produced a matching signature');

	// A provider that sends no delivery id gets one derived from its own bytes,
	// so replay rejection still works — a byte-identical redelivery is exactly
	// what we want to drop.
	const deliveryId = (spec.deliveryIdHeader && headers.get(spec.deliveryIdHeader))
		|| Bun.hash(rawBody).toString(16);

	if (!integrationWebhookQueries.claimDelivery(providerId, deliveryId)) {
		debug.log('integrations', `Ignoring replayed ${providerId} delivery ${deliveryId}`);
		return new Response('OK', { status: 200 });
	}

	pruneDeliveriesOccasionally();

	let payload: unknown = null;
	try {
		payload = JSON.parse(new TextDecoder().decode(rawBody));
	} catch {
		// A provider that posts something other than JSON still gets delivered —
		// subscribers have the raw bytes.
	}

	const event: WebhookEvent = {
		provider: providerId,
		accountId: matched.id,
		deliveryId,
		headers,
		payload,
		rawBody
	};

	// Answer the provider first. A subscriber that throws or hangs must not turn
	// into a delivery failure and a retry storm on their side.
	for (const subscriber of subscribers.get(providerId) ?? []) {
		void Promise.resolve()
			.then(() => subscriber(event))
			.catch((error) => debug.error('integrations', `Webhook subscriber for ${providerId} failed:`, error));
	}

	return new Response('OK', { status: 200 });
}
