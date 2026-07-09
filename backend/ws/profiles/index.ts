/**
 * Profiles Router — Settings → Profiles CRUD + per-session picker + project
 * default + per-profile permission overlay.
 */

import { createRouter } from '$shared/utils/ws-server';
import { profilesCrudHandler } from './crud';

export const profilesRouter = createRouter().merge(profilesCrudHandler);
