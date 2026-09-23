/**
 * Records hook calls that the example otherwise only logs, so the integration tests can check that a
 * hook ran and which request context it received.
 */
export interface HookCall {
  hook: string;
  context?: Record<string, unknown>;
}

export const hookCalls: HookCall[] = [];

export const recordHook = (hook: string, context?: Record<string, unknown>): void => {
  hookCalls.push({ hook, context });
};
