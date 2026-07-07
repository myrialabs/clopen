/**
 * Terminal Router
 *
 * Terminal PTY sessions run on @myrialabs/ptykit. Its embedded WebSocket server
 * is tunneled over Clopen's app-wide socket — see `tunnel.ts`. All session
 * lifecycle, I/O, scrollback reattach, rooms, and reconnect are handled by the
 * PtyKit wire protocol carried on `terminal:pty` / `terminal:pty-out`.
 */

import { createRouter } from '$shared/utils/ws-server';
import { terminalTunnelHandler } from './tunnel';

export const terminalRouter = createRouter().merge(terminalTunnelHandler);
