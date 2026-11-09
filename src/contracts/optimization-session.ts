/** A continuation budget controls work, never the acceptance policy. */
export interface OptimizationSessionBudget {
  time_limit_ms: number;
  max_candidates: number;
}

export const DEFAULT_OPTIMIZATION_BUDGET: OptimizationSessionBudget = {
  time_limit_ms: 60 * 60_000,
  max_candidates: 8,
};

export interface OptimizationSessionEvent {
  id: string;
  sequence: number;
  timestamp: string;
  kind: 'message' | 'tool_call' | 'tool_result' | 'progress' | 'compaction';
  text: string;
  role?: string;
  tool_name?: string;
  is_error?: boolean;
}

export interface OptimizationSessionEvents {
  events: OptimizationSessionEvent[];
  next_cursor: number;
}

export interface OptimizationSessionSummary {
  id: string;
  directory: string;
  turns: number;
  tool_calls: number;
  compactions: number;
  /** Provider-reported tokens; null when the provider has not reported usage. */
  reported_tokens: number | null;
}

export function resolveOptimizationBudget(input?: Partial<OptimizationSessionBudget>): OptimizationSessionBudget {
  const budget = { ...DEFAULT_OPTIMIZATION_BUDGET, ...input };
  if (!Number.isInteger(budget.time_limit_ms) || budget.time_limit_ms < 1000 || budget.time_limit_ms > 24 * 60 * 60_000) {
    throw new Error('time_limit_ms must be an integer from 1000 to 86400000');
  }
  if (!Number.isInteger(budget.max_candidates) || budget.max_candidates < 1 || budget.max_candidates > 1000) {
    throw new Error('max_candidates must be an integer from 1 to 1000');
  }
  return budget;
}
