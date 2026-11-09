/** A missing request is only an observation: a delayed POST may still arrive. */
export type OptimizationIntakeStatus =
  | { status: 'CREATED'; workflow_id: string }
  | { status: 'CLOSED' }
  | { status: 'NOT_FOUND' };

export class OptimizationIntakeConflictError extends Error {
  constructor() { super('Idempotency-Key already used with different optimization inputs'); }
}

export class OptimizationIntakeClosedError extends Error {
  constructor() { super('该创建请求已关闭；请使用新的请求重新提交。'); }
}

export class OptimizationIntakeAmbiguousError extends Error {
  constructor() { super('Idempotency-Key 对应多条历史工作流记录或冲突的关闭记录，无法确认应复用哪条；请联系维护者核对，原记录均已保留。'); }
}
