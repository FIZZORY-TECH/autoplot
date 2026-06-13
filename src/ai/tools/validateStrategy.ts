/**
 * src/ai/tools/validateStrategy.ts — W5-B — `validate_strategy` tool handler.
 *
 * Zod-parses a candidate Strategy. On success returns the parsed object; on
 * failure returns the formatted Zod issue list so the model can self-correct.
 *
 * Non-throwing — the dispatcher's validate-retry pipeline relies on the
 * `{ ok: false, error }` discriminator (NOT a thrown error) so it can count
 * Zod failures separately from engine/runtime failures.
 */
import { z } from 'zod';
import { Strategy, type Strategy as StrategyT } from '../schemas';

export type ValidateStrategyOutput =
  | { ok: true; strategy: StrategyT }
  | { ok: false; error: string };

function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((i) => `${i.path.join('.')}: ${i.message}`)
    .join('; ');
}

export async function validateStrategy(input: unknown): Promise<ValidateStrategyOutput> {
  // Accept either `{ json: <strategy> }` envelope or the strategy directly —
  // tolerate both shapes since the system prompt documents `{ json }`.
  let candidate: unknown = input;
  if (input && typeof input === 'object' && 'json' in (input as Record<string, unknown>)) {
    candidate = (input as { json: unknown }).json;
  }
  const parsed = Strategy.safeParse(candidate);
  if (parsed.success) return { ok: true, strategy: parsed.data };
  return { ok: false, error: formatZodError(parsed.error) };
}
