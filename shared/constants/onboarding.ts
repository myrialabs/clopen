/**
 * The setup wizard's version. Raising it sends every install — fresh or
 * upgraded — through the wizard once more; the wizard pre-fills what an
 * existing install already chose, so nothing is lost by going through it.
 *
 * 1: sign-in, stack, engines, preferences (≤ v0.4)
 * 2: access, sign-in key, AI for Clopen, how Clopen works, first task (v0.5)
 */
export const ONBOARDING_VERSION = 2;
