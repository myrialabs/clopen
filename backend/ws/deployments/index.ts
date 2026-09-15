/**
 * Deployments surface routes.
 *
 * Importing `$backend/deployments` is what registers the providers, so merging
 * this router into the app is also what makes Vercel exist. That is deliberate:
 * a surface with no routes has no adapters to register either.
 */

import { createRouter } from '$shared/utils/ws-server';
import { deploymentsCrudHandler } from './crud';
import { deploymentsActionsHandler } from './actions';

export const deploymentsRouter = createRouter()
	.merge(deploymentsCrudHandler)
	.merge(deploymentsActionsHandler);
