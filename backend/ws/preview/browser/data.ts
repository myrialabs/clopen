/**
 * Browsing Data WebSocket Handler
 *
 * The preview keeps a Chrome profile per workspace, so a login made in a
 * preview tab outlives the tab, the panel and the server. That is the point —
 * and it is also why there has to be a way to take it back. These are the
 * preview's equivalent of a browser's "clear browsing data": one site, or all
 * of them.
 *
 * **PROJECT ISOLATION**: the profile is the project's, and so is the clear.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { requireBrowserPreviewAccess } from '../access';

export const browsingDataPreviewHandler = createRouter()
	// Sites this workspace's preview browser holds data for
	.http(
		'preview:browser-data-list',
		{
			data: t.Object({}),
			response: t.Object({
				sites: t.Array(
					t.Object({
						domain: t.String(),
						origin: t.String(),
						cookies: t.Number(),
						open: t.Boolean()
					})
				)
			})
		},
		async ({ conn }) => {
			const { previewService } = requireBrowserPreviewAccess(conn);
			return { sites: await previewService.listBrowsingData() };
		}
	)

	// Forget one site, or everything
	.http(
		'preview:browser-data-clear',
		{
			data: t.Object({
				/**
				 * Origin to clear. Omitted means every site — including ones
				 * whose tab has long been closed, which is the case the
				 * per-origin call cannot reach.
				 */
				origin: t.Optional(t.String())
			}),
			response: t.Object({
				success: t.Boolean()
			})
		},
		async ({ data, conn }) => {
			const { previewService } = requireBrowserPreviewAccess(conn);
			return { success: await previewService.clearBrowsingData(data.origin) };
		}
	);
