/** Bytes from base64, as a Blob of `mediaType`. */
export function base64ToBlob(data: string, mediaType: string): Blob {
	const binary = atob(data);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return new Blob([bytes], { type: mediaType });
}
