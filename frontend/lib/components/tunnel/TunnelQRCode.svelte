<script lang="ts">
	import { onMount } from 'svelte';
	import QRCode from 'qrcode';

	interface Props {
		value: string;
		size?: number;
	}

	const { value, size = 200 }: Props = $props();
	let canvas: HTMLCanvasElement;

	onMount(() => {
		generateQR();
	});

	$effect(() => {
		if (value) {
			generateQR();
		}
	});

	async function generateQR() {
		if (!canvas) return;

		try {
			await QRCode.toCanvas(canvas, value, {
				width: size,
				margin: 2,
				color: {
					dark: '#000000',
					light: '#FFFFFF'
				}
			});
		} catch (error) {
			console.error('Failed to generate QR code:', error);
		}
	}
</script>

<div class="qr-wrapper flex justify-center p-2">
	<canvas bind:this={canvas} class="qr-canvas rounded-lg"></canvas>
</div>

<style>
	.qr-canvas {
		box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1);
	}
</style>
