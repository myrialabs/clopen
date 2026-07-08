/**
 * Commands Router — Settings → Commands CRUD + on-disk detection.
 */

import { createRouter } from '$shared/utils/ws-server';
import { commandCrudHandler } from './crud';

export const commandsRouter = createRouter().merge(commandCrudHandler);
