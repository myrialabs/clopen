/**
 * Browser Audio Capture Handler
 *
 * Handles audio capture setup and management for headless browser sessions.
 * Audio is captured via AudioContext interception and encoded with AudioEncoder (Opus).
 */

import type { Page } from 'puppeteer';
import type { StreamingConfig } from './types';
import { audioCaptureScript } from './scripts/audio-stream';

export class BrowserAudioCapture {
	/**
	 * Setup audio capture for a page
	 * Injects audio capture script that intercepts AudioContext before page loads
	 */
	async setupAudioCapture(page: Page, config: StreamingConfig['audio']): Promise<void> {
		// Inject audio capture script BEFORE page loads to intercept AudioContext
		await page.evaluateOnNewDocument(audioCaptureScript, config);
	}

	/**
	 * Check if audio encoder is supported in the page
	 */
	async isAudioSupported(page: Page): Promise<boolean> {
		try {
			return await page.evaluate(() => {
				return typeof (window as any).__audioEncoder?.isSupported === 'function'
					&& (window as any).__audioEncoder.isSupported();
			});
		} catch {
			return false;
		}
	}

	/**
	 * Initialize and start audio capture
	 */
	async startAudioCapture(page: Page): Promise<boolean> {
		try {
			const initialized = await page.evaluate(async () => {
				const encoder = (window as any).__audioEncoder;
				if (!encoder) return false;

				const initiated = await encoder.init();
				if (initiated) {
					return encoder.start();
				}
				return false;
			});

			return initialized;
		} catch (error) {
			return false;
		}
	}

	/**
	 * Stop audio capture
	 */
	async stopAudioCapture(page: Page): Promise<void> {
		try {
			await page.evaluate(() => {
				const encoder = (window as any).__audioEncoder;
				if (encoder) {
					encoder.stop();
				}
			});
		} catch {
			// Ignore errors during cleanup
		}
	}

	/**
	 * Check if audio is currently being captured
	 */
	async isCapturing(page: Page): Promise<boolean> {
		try {
			return await page.evaluate(() => {
				return (window as any).__audioEncoder?.isCapturing() || false;
			});
		} catch {
			return false;
		}
	}
}
