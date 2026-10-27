/**
 * Chat-app platforms, keyed by integration provider id.
 */

import { telegramPlatform } from './telegram';
import type { ChannelPlatform } from './types';

export type { ChannelButton, ChannelCard, ChannelCommand, ChannelFile, ChannelFragment, ChannelHealth, ChannelPlatform, DeliveryMode } from './types';

const PLATFORMS: readonly ChannelPlatform[] = [telegramPlatform];

const byProvider = new Map(PLATFORMS.map((platform) => [platform.provider, platform]));

export function getChannelPlatform(provider: string): ChannelPlatform | null {
	return byProvider.get(provider) ?? null;
}

export function listChannelPlatforms(): readonly ChannelPlatform[] {
	return PLATFORMS;
}
