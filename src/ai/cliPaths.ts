/**
 * src/ai/cliPaths.ts — CLI version-band constants.
 *
 * Originally lived in claudeClient.ts; extracted here so FirstRun.tsx can
 * import the constant without dragging in the full AI invocation stack.
 */

export const SUPPORTED_CLI = {
  minVersion: '1.0.0',
  maxKnown: '2.x',
} as const;
