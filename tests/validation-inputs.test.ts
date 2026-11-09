import assert from 'node:assert/strict';
import test from 'node:test';
import { parseValidationInputs, ValidationInputError } from '../src/evaluator/validation-inputs.js';

test('omitted workload metadata preserves existing policy and supplies defaults only for new inputs', () => {
  const prior = [{ workload_id: 'large', parameters: { length: 128 }, threads: 8, critical: true, weight: 2.5 }];
  const parsed = parseValidationInputs([{ workload_id: 'large', parameters: { length: 256 } },
    { workload_id: 'small', parameters: { length: 16 } }], 'workloads', prior);
  assert.deepEqual(parsed, [{ workload_id: 'large', parameters: { length: 256 }, threads: 8, critical: true, weight: 2.5 },
    { workload_id: 'small', parameters: { length: 16 }, threads: 1, critical: false, weight: 1 }]);
  assert.deepEqual(prior[0].parameters, { length: 128 });
  assert.deepEqual(parseValidationInputs([{ case_id: 'check', parameters: {} }], 'cases'), [{ case_id: 'check', parameters: {}, threads: 1 }]);
});

test('invalid fields identify their exact row and field; explicit invalid values never turn into defaults', () => {
  const input = { workload_id: 'small', parameters: { length: 16 }, threads: 4, critical: true, weight: 2 };
  for (const [patch, field] of [
    [{ threads: 0 }, 'threads'], [{ threads: '4' }, 'threads'], [{ threads: null }, 'threads'],
    [{ weight: 0 }, 'weight'], [{ weight: Number.NaN }, 'weight'], [{ weight: -1 }, 'weight'],
    [{ critical: null }, 'critical'], [{ critical: 'false' }, 'critical'],
    [{ parameters: { length: [16, 32] } }, 'parameters.length'], [{ parameters: { alpha: { real: 1, imag: 0 } } }, 'parameters.alpha'],
    [{ parameters: { length: Number.POSITIVE_INFINITY } }, 'parameters.length'], [{ parameters: { length: null } }, 'parameters.length'],
    [{ workload_id: 'small matrix' }, 'workload_id'], [{ workload_id: '' }, 'workload_id'],
  ] as const) {
    assert.throws(() => parseValidationInputs([{ ...input, ...patch }], 'workloads', [input]), error =>
      error instanceof ValidationInputError && error.field === `workloads[0].${field}` && error.message.includes('第 1 行性能负载'));
  }
  assert.throws(() => parseValidationInputs([input, input], 'workloads'), error =>
    error instanceof ValidationInputError && error.field === 'workloads[1].workload_id' && /第 2 行.*第 1 行重复/.test(error.message));
  assert.throws(() => parseValidationInputs([], 'workloads'), /1～200/);
});

test('valid scalar inputs, explicit metadata changes and deterministic recipes are retained', () => {
  const input = { workload_id: 'complex-input', parameters: { alpha_real: -1.5, alpha_imag: 0, datatype: 'complex128', transposed: false },
    threads: 2, critical: false, weight: 0.5, input_generation: '  Deterministic row-major input.  ' };
  const prior = [{ ...input, threads: 8, critical: true, weight: 4 }];
  assert.deepEqual(parseValidationInputs([input], 'workloads', prior), [{ ...input, input_generation: 'Deterministic row-major input.' }]);
});
