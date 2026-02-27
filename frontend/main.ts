/**
 * Clopen - SPA Entry Point
 * Mounts the Svelte application to the DOM (Svelte 5)
 */
import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';

const app = mount(App, {
	target: document.getElementById('app')!
});

export default app;
