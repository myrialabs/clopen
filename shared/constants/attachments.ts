/**
 * Attachment limits shared by the web composer, the chat apps and the stream.
 *
 * Any file can be attached. What the model reads inline (images and PDFs, when
 * its modalities say so, up to the inline limit) is sent as-is; everything
 * else is saved into the session's working tree and named in the prompt — see
 * `backend/chat/attachments.ts`.
 */

/** Largest file accepted anywhere — Telegram's own download ceiling. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** Largest file sent to the model inline; a bigger image or PDF is saved instead. */
export const MAX_INLINE_ATTACHMENT_BYTES = 10 * 1024 * 1024;
