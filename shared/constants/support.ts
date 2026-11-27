/**
 * Ways to fund Clopen's development — the single source for every surface
 * that shows them (Settings → Support Clopen, the What's new dialog).
 *
 * The README's Support table lists the same methods for people who never open
 * the app; support.test.ts fails if the two drift apart, because a wrong
 * address here sends someone's money nowhere.
 */

export interface CryptoSupportMethod {
	id: 'btc' | 'eth' | 'usdt-trc20' | 'usdc-bep20' | 'sol';
	/** Short label for the network picker. */
	symbol: string;
	/** Coin name, as a person would say it. */
	name: string;
	/** The chain the address lives on — sending on any other one loses the funds. */
	network: string;
	address: string;
}

export interface LinkSupportMethod {
	id: 'saweria';
	name: string;
	/** Who can use it — Saweria only takes Indonesian payment methods. */
	region: string;
	detail: string;
	url: string;
}

/** Ordered for a global audience: the most widely held coins first. */
export const CRYPTO_SUPPORT_METHODS: readonly CryptoSupportMethod[] = [
	{
		id: 'btc',
		symbol: 'BTC',
		name: 'Bitcoin',
		network: 'Bitcoin',
		address: 'bc1qd9fyx4r84cce2a9hkjksetah802knadw5msls3'
	},
	{
		id: 'eth',
		symbol: 'ETH',
		name: 'Ethereum',
		network: 'Ethereum (ERC-20)',
		address: '0x61D826e5b666AA5345302EEEd485Acca39b1AFCF'
	},
	{
		id: 'usdt-trc20',
		symbol: 'USDT',
		name: 'Tether',
		network: 'Tron (TRC-20)',
		address: 'TLH49i3EoVKhFyLb6u2JUXZWScK7uzksdC'
	},
	{
		id: 'usdc-bep20',
		symbol: 'USDC',
		name: 'USD Coin',
		network: 'BNB Smart Chain (BEP-20)',
		address: '0x61D826e5b666AA5345302EEEd485Acca39b1AFCF'
	},
	{
		id: 'sol',
		symbol: 'SOL',
		name: 'Solana',
		network: 'Solana',
		address: 'Ev3P4KLF1PNC5C9rZYP8M3DdssyBQAQAiNJkvNmPQPVs'
	}
];

export const LINK_SUPPORT_METHODS: readonly LinkSupportMethod[] = [
	{
		id: 'saweria',
		name: 'Saweria',
		region: 'Indonesia',
		detail: 'QRIS and e-wallets',
		url: 'https://saweria.co/myrialabs'
	}
];

export const REPOSITORY_URL = 'https://github.com/myrialabs/clopen';
