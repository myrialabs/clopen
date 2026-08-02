/**
 * Tool schema, assembled from the action registry.
 */

import { z } from 'zod';
import { ALL_ACTIONS } from './actions';

const members = ALL_ACTIONS.map((action) => action.schema) as unknown as [
	z.ZodObject<any>,
	z.ZodObject<any>,
	...z.ZodObject<any>[]
];

/** One action. Discriminated on `type`, so a wrong field is rejected up front. */
export const actionSchema = z.discriminatedUnion('type', members);

export const actionsToolSchema = {
	actions: z
		.array(actionSchema)
		.min(1)
		.describe('Actions to run in order. Batch everything that does not depend on what you would learn from the result.'),
	onError: z
		.enum(['stop', 'continue'])
		.optional()
		.describe('stop (default): remaining actions are skipped after a failure. continue: run them all. Per-action `optional: true` overrides this for that action.')
};
