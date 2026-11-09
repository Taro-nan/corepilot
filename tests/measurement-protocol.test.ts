import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluatorCommandEnvironment, isMeasurementPrefix, measurementPayload } from '../src/evaluator/measurement-protocol.js';
import { candidateRelativePath, hasCandidateRoot, resolveCandidateRoot } from '../src/config/runtime-path.js';

test('evaluator resource aliases are an execution copy and cannot overwrite Runner-owned facts', () => {
  const command = { executable: 'test', args: [], cwd: '.', timeout_ms: 1000,
    environment: { COREPILOT_DECLARED_CPU_SET: '0-3', COREPILOT_DECLARED_NUMA_NODE: '0', COREPILOT_RESOURCE_ENFORCEMENT: 'ENFORCED', ARCHIVE_DECLARED_CPU_SET: 'wrong', OMP_NUM_THREADS: '4' } };
  const adapted = evaluatorCommandEnvironment(command, 'ARCHIVE_MEASUREMENT');
  assert.equal(adapted.environment.ARCHIVE_DECLARED_CPU_SET, '0-3');
  assert.equal(adapted.environment.ARCHIVE_RESOURCE_ENFORCEMENT, 'ENFORCED');
  assert.equal(adapted.environment.COREPILOT_DECLARED_CPU_SET, '0-3');
  assert.equal(adapted.environment.OMP_NUM_THREADS, '4');
  assert.equal(command.environment.ARCHIVE_DECLARED_CPU_SET, 'wrong');
  assert.equal(evaluatorCommandEnvironment(command, 'COREPILOT_MEASUREMENT'), command);
});

test('measurement framing honors the exact declared namespace and rejects malformed prefixes', () => {
  assert.equal(measurementPayload('ARCHIVE_MEASUREMENT {"value":1}', 'ARCHIVE_MEASUREMENT'), '{"value":1}');
  assert.equal(measurementPayload('ARCHIVE_MEASUREMENT {"value":1}', 'COREPILOT_MEASUREMENT'), null);
  assert.equal(measurementPayload('COREPILOT_MEASUREMENT {"value":2}'), '{"value":2}');
  assert.equal(measurementPayload('log line'), null);
  for (const value of ['COREPILOT_MEASUREMENT extra', 'bad-prefix_MEASUREMENT', 'MEASUREMENT', null]) assert.equal(isMeasurementPrefix(value), false);
});

test('candidate runtime roots stay target-relative regardless of the frozen producer namespace', () => {
  for (const namespace of ['COREPILOT', 'ARCHIVE']) {
    const input = '${' + namespace + '_CANDIDATE_ROOT}/build/libtest.so';
    assert.equal(hasCandidateRoot(input), true);
    assert.equal(resolveCandidateRoot(input, '/runner/candidate'), '/runner/candidate/build/libtest.so');
    assert.equal(candidateRelativePath(input), 'build/libtest.so');
  }
  assert.equal(hasCandidateRoot('/home/source/libtest.so'), false);
  assert.equal(candidateRelativePath('/home/source/libtest.so'), null);
});
