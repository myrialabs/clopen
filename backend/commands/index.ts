/**
 * Custom Commands — public facade. Settings → Commands manages reusable slash
 * command prompts, materialized into each engine at stream start.
 */

export { commandService } from './service';
export type { CommandDTO, CommandInputFields } from './service';
export { syncCommands, syncCommandsAllEngines } from './sync';
export { detectCommands } from './detect';
