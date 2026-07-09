/**
 * Permissions Router — Settings → Permissions (per-engine tool allow/deny).
 */

import { createRouter } from '$shared/utils/ws-server';
import { permissionsCrudHandler } from './crud';

export const permissionsRouter = createRouter().merge(permissionsCrudHandler);
