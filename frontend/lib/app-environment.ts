/**
 * App environment utilities for Vite SPA mode.
 *
 * browser is always true (no SSR), building is always false.
 */

export const browser = typeof window !== 'undefined';
export const building = false;
export const dev = import.meta.env.DEV;
export const version = import.meta.env.VITE_APP_VERSION || '0.0.1';
