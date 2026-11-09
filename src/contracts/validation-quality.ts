/** Evaluator-owned semantic coverage and executable known-bad controls. */
export interface ValidationQualityPlan {
  schema_version: 1;
  coverage: Array<{ dimension: string; input_ids: string[]; rationale: string; status: 'COVERED' | 'NOT_APPLICABLE' | 'UNKNOWN' }>;
  /** Built by the evaluator setup script; paths are relative to runtime_root. */
  probes: Array<{ probe_id: string; defect: string; artifact: string; input_ids: string[] }>;
}

export interface ValidationQualityResult {
  logical_inputs: number;
  correctness_executions: number;
  coverage: ValidationQualityPlan['coverage'];
  status: 'NOT_CONFIGURED' | 'PENDING' | 'PASSED' | 'FAILED';
  probes: Array<{ probe_id: string; defect: string; detected: boolean; observations: number; detecting_inputs: string[] }>;
  unknown_dimensions: string[];
}
