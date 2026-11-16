/**
 * Tool schema, assembled from the action registry.
 */

import { z } from 'zod';
import { ALL_ACTIONS } from './actions/index';

/**
 * Optional fields also take null: models often fill a field they do not use
 * with null, and rejecting that rejected the whole batch. The runner drops
 * the nulls before anything runs.
 */
function allowNull(schema: z.ZodObject<any>): z.ZodObject<any> {
	const shape = Object.fromEntries(
		Object.entries(schema.shape as Record<string, z.ZodType>).map(([key, field]) => {
			if (!(field instanceof z.ZodOptional)) return [key, field];
			const inner = field.unwrap() as z.ZodType;
			const nullable = inner.nullable().optional();
			return [key, field.description ? nullable.describe(field.description) : nullable];
		})
	);
	return z.object(shape);
}

const members = ALL_ACTIONS.map((action) => allowNull(action.schema)) as unknown as [
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
