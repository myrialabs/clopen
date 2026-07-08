/**
 * Artifacts Router — cross-cutting artifact operations (AI generation).
 */

import { createRouter } from '$shared/utils/ws-server';
import { artifactGenerateHandler } from './generate';

export const artifactsRouter = createRouter().merge(artifactGenerateHandler);
