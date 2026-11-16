/**
 * Project Instructions — public facade. Library → Rules manages a
 * marker-region block injected into each engine's memory file (global + project).
 */

export { instructionService } from './service';
export type { InstructionDTO } from './service';
export { syncInstructions, buildInstructionsPromptContext } from './sync';
