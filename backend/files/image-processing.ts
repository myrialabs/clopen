/**
 * Image Processing
 *
 * Applies an `ImageEditRecipe` to an image on disk using sharp and returns the
 * encoded result as a Buffer. The client editor only ever sends a small
 * declarative recipe — the full-resolution original is read here so quality is
 * never bounded by what the browser downscaled for preview.
 *
 * Geometry is deterministic: for static images we fully bake rotate/flip into a
 * raw intermediate buffer first, so the crop rectangle always maps to the
 * orientation the user cropped against (sharp's single-pipeline op ordering is
 * not call-order, so we stage it ourselves). Animated images (GIF/WebP) are
 * processed in a single `{ animated: true }` pass to preserve their frames.
 */

import sharp from 'sharp';
import type { Sharp } from 'sharp';

import type { ImageEditRecipe, ImageEditRegion, ImageEditStroke } from '$shared/types/filesystem';
import { validateFileSize } from './file-size-limit';

export interface ProcessedImage {
	data: Buffer;
	format: string;
	width: number;
	height: number;
	size: number;
}

/** Clamp a value into [min, max], rounding to an integer. */
function clampInt(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, Math.round(value)));
}

/** Apply the color/tone adjustments shared by both processing paths. */
function applyColor(pipeline: Sharp, recipe: ImageEditRecipe): Sharp {
	let p = pipeline;
	if (recipe.background) {
		// Composite any transparency onto a solid colour (e.g. for JPEG export).
		p = p.flatten({ background: recipe.background });
	}
	if (recipe.grayscale) {
		p = p.grayscale();
	}
	const brightness = recipe.brightness ?? 1;
	const saturation = recipe.saturation ?? 1;
	const hue = Math.round(recipe.hue ?? 0);
	if (brightness !== 1 || saturation !== 1 || hue !== 0) {
		p = p.modulate({ brightness, saturation, hue });
	}
	if (recipe.contrast != null && recipe.contrast !== 1) {
		// Linear contrast around the 128 midpoint: out = slope*in + intercept.
		p = p.linear(recipe.contrast, -(128 * recipe.contrast) + 128);
	}
	if (recipe.sepia) {
		// Standard sepia matrix (matches the CSS `sepia(1)` filter).
		p = p.recomb([
			[0.393, 0.769, 0.189],
			[0.349, 0.686, 0.168],
			[0.272, 0.534, 0.131]
		]);
	}
	if (recipe.invert) {
		p = p.negate({ alpha: false });
	}
	if (recipe.blur != null && recipe.blur > 0) {
		p = p.blur(Math.max(0.3, recipe.blur));
	}
	return p;
}

/** True when the recipe applies any geometry, color, region or annotation change. */
function hasEdits(recipe: ImageEditRecipe): boolean {
	return (
		!!recipe.crop ||
		!!recipe.resize ||
		!!recipe.rotate ||
		!!recipe.flipH ||
		!!recipe.flipV ||
		(recipe.brightness != null && recipe.brightness !== 1) ||
		(recipe.saturation != null && recipe.saturation !== 1) ||
		(recipe.contrast != null && recipe.contrast !== 1) ||
		(recipe.hue != null && recipe.hue !== 0) ||
		(recipe.blur != null && recipe.blur > 0) ||
		!!recipe.grayscale ||
		!!recipe.sepia ||
		!!recipe.invert ||
		(recipe.regions?.length ?? 0) > 0 ||
		(recipe.annotations?.length ?? 0) > 0
	);
}

/** Build a composite layer that blurs or pixelates one region of the oriented image. */
async function buildRegionComposite(
	orientedBuf: Buffer,
	region: ImageEditRegion,
	imgWidth: number,
	imgHeight: number
): Promise<{ input: Buffer; left: number; top: number }> {
	const r = boundCrop(
		{ left: region.left, top: region.top, width: region.width, height: region.height },
		imgWidth,
		imgHeight
	);
	const strength = Math.max(1, Math.min(100, region.strength || 1));
	let img = sharp(orientedBuf).extract(r);
	if (region.type === 'blur') {
		img = img.blur(Math.max(0.3, strength / 3));
	} else {
		// Mosaic: downscale with nearest-neighbour, then scale back up.
		const factor = Math.max(2, Math.round(strength / 3));
		const dw = Math.max(1, Math.round(r.width / factor));
		const dh = Math.max(1, Math.round(r.height / factor));
		img = img
			.resize(dw, dh, { kernel: 'nearest' })
			.resize(r.width, r.height, { kernel: 'nearest' });
	}
	return { input: await img.png().toBuffer(), left: r.left, top: r.top };
}

/** Render freehand strokes to an SVG overlay sized to the oriented image. */
function buildAnnotationSvg(strokes: ImageEditStroke[], width: number, height: number): string {
	const lines = strokes
		.map((s) => {
			const color = /^#[0-9a-fA-F]{3,8}$/.test(s.color) ? s.color : '#ef4444';
			const w = Math.max(1, Math.min(400, s.size || 4));
			const opacity = Math.max(0, Math.min(1, s.opacity ?? 1));
			const pts = s.points
				.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
				.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`)
				.join(' ');
			if (!pts) return '';
			return `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="${w}" stroke-opacity="${opacity}" stroke-linecap="round" stroke-linejoin="round"/>`;
		})
		.join('');
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${lines}</svg>`;
}

/**
 * Encode the pipeline into the requested output format.
 *
 * `compress` opt-in (per format):
 * - off → preserve quality: lossless for PNG/WebP, high quality otherwise. The
 *   caller copies the original byte-for-byte when there are no other edits, so
 *   this path only runs when geometry/color/format actually changed.
 * - on  → efficient codecs that shrink files at visually-equivalent quality:
 *   mozjpeg for JPEG, palette quantization for PNG (in encodeToBuffer),
 *   efficient lossy WebP/AVIF.
 */
function encode(pipeline: Sharp, output: ImageEditRecipe['output'], fast = false): Sharp {
	const compress = output.compress ?? false;
	const quality = output.quality ?? 80;
	switch (output.format) {
		case 'png':
			// Lossy PNG (palette quantization) is handled in encodeToBuffer; here
			// we always produce the lossless variant. `fast` trades a little size
			// accuracy for speed (used by the live estimate on large images).
			return pipeline.png({ compressionLevel: fast ? 6 : 9, effort: fast ? 1 : 10 });
		case 'jpeg':
			// mozjpeg = trellis quantization + optimized Huffman + progressive.
			return pipeline.jpeg({ quality: compress ? quality : 95, mozjpeg: true });
		case 'webp':
			return output.lossless || !compress
				? pipeline.webp({ lossless: true, effort: fast ? 0 : 6 })
				: pipeline.webp({ quality, effort: fast ? 0 : 6, smartSubsample: true });
		case 'gif':
			return pipeline.gif({ dither: 1 });
		case 'avif':
			// Off = preserve quality (near-lossless); on = the requested quality.
			// Keep the two clearly apart so toggling compression changes the size.
			// AVIF effort is the slowest knob — drop it hard for the estimate.
			return pipeline.avif({ quality: compress ? (output.quality ?? 80) : 92, effort: fast ? 0 : 4 });
		default: {
			// Exhaustiveness guard — unreachable for valid recipes.
			const never: never = output.format;
			throw new Error(`Unsupported output format: ${String(never)}`);
		}
	}
}

/**
 * Apply a recipe to the image at `sourcePath` and return the encoded result.
 * Throws if the source is not a decodable image or the output exceeds the
 * configured file-size limit.
 */
export async function processImageEdit(
	sourcePath: string,
	recipe: ImageEditRecipe,
	fast = false
): Promise<ProcessedImage> {
	const srcMeta = await sharp(sourcePath, { animated: true }).metadata();
	if (!srcMeta.width || !srcMeta.height) {
		throw new Error('Source file is not a readable image');
	}

	// Nothing to do: not compressing, no edits, and the format is unchanged →
	// return the original bytes verbatim so an untouched file stays identical.
	const compress = recipe.output.compress ?? false;
	if (!compress && !hasEdits(recipe) && srcMeta.format === recipe.output.format) {
		const data = Buffer.from(await Bun.file(sourcePath).arrayBuffer());
		validateFileSize(data.length);
		return {
			data,
			format: srcMeta.format ?? recipe.output.format,
			width: srcMeta.width,
			height: srcMeta.height,
			size: data.length
		};
	}

	const animated = (srcMeta.pages ?? 1) > 1;
	const rotate = recipe.rotate ?? 0;

	let pipeline: Sharp;

	if (animated) {
		// Single pass keeps every frame. sharp applies extract/resize per frame.
		let p = sharp(sourcePath, { animated: true });
		if (rotate) p = p.rotate(rotate);
		if (recipe.flipV) p = p.flip();
		if (recipe.flipH) p = p.flop();
		if (recipe.crop) {
			p = p.extract(boundCrop(recipe.crop, srcMeta.width, srcMeta.height));
		}
		if (recipe.resize) {
			p = p.resize(Math.round(recipe.resize.width), Math.round(recipe.resize.height), { fit: 'fill' });
		}
		pipeline = applyColor(p, recipe);
	} else {
		// The browser decodes images with EXIF orientation applied, so the editor's
		// coordinates live in that space. EXIF-oriented dimensions are derived from
		// metadata (orientation 5–8 swap W/H) so the common no-rotation path never
		// has to fully decode a large image just to estimate its size.
		const exifSwap = (srcMeta.orientation ?? 1) >= 5;
		const baseW = exifSwap ? srcMeta.height : srcMeta.width;
		const baseH = exifSwap ? srcMeta.width : srcMeta.height;

		const quarterTurn = rotate === 90 || rotate === 270;
		const orientedWidth = quarterTurn ? baseH : baseW;
		const orientedHeight = quarterTurn ? baseW : baseH;

		const regions = recipe.regions ?? [];
		const annotations = recipe.annotations ?? [];

		// Decode the EXIF-auto-oriented source into a raw buffer. Only used when a
		// rotation/flip must be baked (so crop maps after rotation) or overlays are
		// composited — the plain path below stays lazy.
		const decodeOrientedRaw = async () => {
			const { data, info } = await sharp(sourcePath)
				.rotate()
				.ensureAlpha()
				.raw()
				.toBuffer({ resolveWithObject: true });
			return sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } });
		};

		if (regions.length > 0 || annotations.length > 0) {
			// Bake orientation + color first, then composite blur/pixelate regions
			// and freehand strokes in oriented space, then crop/resize/encode.
			let oriented = (await decodeOrientedRaw()).rotate(rotate);
			if (recipe.flipV) oriented = oriented.flip();
			if (recipe.flipH) oriented = oriented.flop();
			oriented = applyColor(oriented, recipe);
			const orientedBuf = await oriented.png().toBuffer();

			// Composite layers must fit the *actual* baked buffer, which can differ
			// from the metadata-derived oriented size by a sub-pixel after EXIF
			// auto-orient + rotate. Measure the real dimensions and size every
			// layer against them, or sharp rejects them ("same dimensions or smaller").
			const bakedMeta = await sharp(orientedBuf).metadata();
			const ow = bakedMeta.width ?? orientedWidth;
			const oh = bakedMeta.height ?? orientedHeight;

			const composites: { input: Buffer; left: number; top: number }[] = [];
			for (const region of regions) {
				composites.push(await buildRegionComposite(orientedBuf, region, ow, oh));
			}
			if (annotations.length > 0) {
				// Rasterize the overlay to an exact-size PNG first. Compositing a raw
				// SVG buffer can be rejected ("same dimensions or smaller") when
				// librsvg rounds the raster up by a sub-pixel versus the base.
				const svg = buildAnnotationSvg(annotations, ow, oh);
				const svgPng = await sharp(Buffer.from(svg))
					.resize(ow, oh, { fit: 'fill' })
					.png()
					.toBuffer();
				composites.push({ input: svgPng, left: 0, top: 0 });
			}

			// Flatten the composites into the base BEFORE cropping/resizing. sharp
			// orders pipeline ops internally (extract/resize run before composite),
			// so chaining .composite().extract() on one pipeline would crop the base
			// first and then reject the full-size overlay. Baking to a buffer pins
			// the overlay to the full oriented frame it was authored against.
			const compositedBuf =
				composites.length > 0
					? await sharp(orientedBuf).composite(composites).png().toBuffer()
					: orientedBuf;

			let p = sharp(compositedBuf);
			if (recipe.crop) {
				p = p.extract(boundCrop(recipe.crop, ow, oh));
			}
			if (recipe.resize) {
				p = p.resize(Math.round(recipe.resize.width), Math.round(recipe.resize.height), { fit: 'fill' });
			}
			// Color already baked above.
			pipeline = p;
		} else if (rotate || recipe.flipH || recipe.flipV) {
			// Bake EXIF + user orientation into a raw buffer so the crop coordinates
			// (expressed against the oriented preview) map exactly — sharp's single
			// pipeline does not honor rotate-before-extract call order.
			let pre = (await decodeOrientedRaw()).rotate(rotate);
			if (recipe.flipV) pre = pre.flip();
			if (recipe.flipH) pre = pre.flop();
			const { data, info } = await pre.raw().toBuffer({ resolveWithObject: true });
			let p = sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } });
			if (recipe.crop) {
				p = p.extract(boundCrop(recipe.crop, orientedWidth, orientedHeight));
			}
			if (recipe.resize) {
				p = p.resize(Math.round(recipe.resize.width), Math.round(recipe.resize.height), { fit: 'fill' });
			}
			pipeline = applyColor(p, recipe);
		} else {
			// No rotation/flip: stay lazy. `.rotate()` auto-orients via EXIF before
			// extract, so crop coordinates still map to the displayed image.
			let p = sharp(sourcePath).rotate();
			if (recipe.crop) {
				p = p.extract(boundCrop(recipe.crop, orientedWidth, orientedHeight));
			}
			if (recipe.resize) {
				p = p.resize(Math.round(recipe.resize.width), Math.round(recipe.resize.height), { fit: 'fill' });
			}
			pipeline = applyColor(p, recipe);
		}
	}

	const { data, info } = await encodeToBuffer(pipeline, recipe.output, fast);

	// Guard against producing an output larger than the admin file-size limit.
	validateFileSize(data.length);

	return {
		data,
		format: info.format,
		width: info.width,
		height: info.height,
		size: data.length
	};
}

/**
 * Encode to a Buffer. For lossy PNG we render both palette-quantized and
 * lossless variants and keep the smaller one — palette quantization shrinks
 * photographic PNGs dramatically but can *grow* smooth/continuous-tone images,
 * so "compress" must never increase the size.
 */
async function encodeToBuffer(
	pipeline: Sharp,
	output: ImageEditRecipe['output'],
	fast = false
): Promise<{ data: Buffer; info: { format: string; width: number; height: number } }> {
	if (output.format === 'png' && (output.compress ?? false) && !output.lossless) {
		const quality = output.quality ?? 80;
		// Estimate path: a single fast palette encode instead of the dual
		// palette/lossless comparison (which is too slow on large images).
		if (fast) {
			return pipeline
				.png({ palette: true, quality, dither: 1, effort: 1, compressionLevel: 6 })
				.toBuffer({ resolveWithObject: true });
		}
		const [palette, lossless] = await Promise.all([
			pipeline
				.clone()
				.png({ palette: true, quality, dither: 1, effort: 10, compressionLevel: 9 })
				.toBuffer({ resolveWithObject: true }),
			pipeline.clone().png({ compressionLevel: 9, effort: 10 }).toBuffer({ resolveWithObject: true })
		]);
		return palette.data.length <= lossless.data.length ? palette : lossless;
	}
	return encode(pipeline, output, fast).toBuffer({ resolveWithObject: true });
}

/** Clamp a crop rectangle so it always sits within the image bounds. */
function boundCrop(
	crop: NonNullable<ImageEditRecipe['crop']>,
	imgWidth: number,
	imgHeight: number
): { left: number; top: number; width: number; height: number } {
	const left = clampInt(crop.left, 0, Math.max(0, imgWidth - 1));
	const top = clampInt(crop.top, 0, Math.max(0, imgHeight - 1));
	const width = clampInt(crop.width, 1, imgWidth - left);
	const height = clampInt(crop.height, 1, imgHeight - top);
	return { left, top, width, height };
}
