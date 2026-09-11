/**
 * Work surface routes — issues, pull requests and CI.
 *
 * Importing `$backend/work` is what registers the providers, so merging this
 * router into the app is also what makes GitHub exist. That is deliberate: a
 * surface with no routes has no adapters to register either.
 */

import { createRouter } from '$shared/utils/ws-server';
import { workCrudHandler } from './crud';
import { workActionsHandler } from './actions';
import { workPullRequestHandler } from './pull-requests';

export const workRouter = createRouter()
	.merge(workCrudHandler)
	.merge(workActionsHandler)
	.merge(workPullRequestHandler);
