/**
 * File system related types
 */

import type { IconName } from '../ui/icons';

export interface FileNode {
	name: string;
	path: string;
	type: 'file' | 'directory';
	children?: FileNode[];
	size?: number;
	modified?: Date;
	icon?: IconName;
}

export interface FileChange {
	path: string;
	type: 'created' | 'modified' | 'deleted';
	timestamp: string;
	diff?: string;
}

/** Raster output formats the image editor can encode (round-trippable by sharp). */
export type ImageEditFormat = 'png' | 'jpeg' | 'webp' | 'gif' | 'avif';

/** A freehand annotation stroke, in oriented (post-rotate/flip) source pixels. */
export interface ImageEditStroke {
	/** Stroke color as a hex string (e.g. "#ef4444"). */
	color: string;
	/** Stroke width in source pixels. */
	size: number;
	/** 0–1 opacity. */
	opacity?: number;
	/** Polyline points in oriented source pixels. */
	points: { x: number; y: number }[];
}

/** A rectangular region to blur or pixelate, in oriented source pixels. */
export interface ImageEditRegion {
	type: 'blur' | 'pixelate';
	left: number;
	top: number;
	width: number;
	height: number;
	/** 1–100; higher = stronger blur / larger mosaic blocks. */
	strength: number;
}

/**
 * A declarative description of the edits to apply to an image. Produced by the
 * client editor and applied authoritatively on the backend with sharp against
 * the full-resolution original. All geometry is expressed in the source image's
 * pixel space (crop is applied before rotate/flip/resize).
 */
export interface ImageEditRecipe {
	/** Crop rectangle in source pixels. Omit to keep full frame. */
	crop?: { left: number; top: number; width: number; height: number };
	/** Target dimensions after crop. Omit to keep cropped size. */
	resize?: { width: number; height: number };
	/** Clockwise rotation in degrees (0/90/180/270). */
	rotate?: 0 | 90 | 180 | 270;
	/** Mirror horizontally (flop). */
	flipH?: boolean;
	/** Mirror vertically (flip). */
	flipV?: boolean;
	/** Lightness multiplier — 1 = unchanged. */
	brightness?: number;
	/** Saturation multiplier — 1 = unchanged. */
	saturation?: number;
	/** Contrast slope — 1 = unchanged. */
	contrast?: number;
	/** Hue rotation in degrees (-180..180). 0 = unchanged. */
	hue?: number;
	/** Gaussian blur sigma (px). 0 / omitted = no blur. */
	blur?: number;
	/** Desaturate to grayscale. */
	grayscale?: boolean;
	/** Apply a sepia tone. */
	sepia?: boolean;
	/** Invert colors (photo negative). */
	invert?: boolean;
	/** Flatten transparency onto this hex background (e.g. when exporting JPEG). */
	background?: string;
	/** Blur/pixelate regions, applied in oriented space before cropping. */
	regions?: ImageEditRegion[];
	/** Freehand annotation strokes, composited on top in oriented space. */
	annotations?: ImageEditStroke[];
	/** Output encoding. */
	output: {
		format: ImageEditFormat;
		/**
		 * Opt-in compression. When false (default) the image is preserved at
		 * original quality — and with no other edits it is copied byte-for-byte.
		 * When true, an efficient codec is applied to reduce the file size.
		 */
		compress?: boolean;
		/** Quality 1–100 for lossy encoders (jpeg/webp/avif) when compressing. */
		quality?: number;
		/** Force lossless encoding where supported (png/webp). */
		lossless?: boolean;
	};
}