/**
 * OpenAI Codex Engine Router
 *
 * Combines status detection and account management handlers (incl. dual auth
 * flow — API key + ChatGPT browser OAuth + device-auth fallback).
 */

import { createRouter } from '$shared/utils/ws-server';
import { codexStatusHandler } from './status';
import { codexAccountsHandler } from './accounts';

export const codexEngineRouter = createRouter()
	.merge(codexStatusHandler)
	.merge(codexAccountsHandler);
