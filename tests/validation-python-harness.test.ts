import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { VALIDATION_PYTHON_HARNESS } from '../src/application/validation-python-harness.js';

const python = process.platform === 'win32' ? 'python' : 'python3';

test('Python adapter asks the platform loader for symbol ownership', t => {
  if (spawnSync(python, ['--version'], { windowsHide: true }).status !== 0) return t.skip('Python unavailable');
  const script = `import ctypes, json, os, sys\nnamespace={}\nexec(sys.stdin.read(),namespace)\np=namespace['_symbol_library_path'](ctypes.pythonapi.Py_IsInitialized)\nprint(json.dumps({'path':p,'exists':os.path.isfile(p)}))\n`;
  const run = spawnSync(python, ['-c', script], { input: VALIDATION_PYTHON_HARNESS, encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout) as { path: string; exists: boolean };
  assert.equal(result.exists, true);
  assert.equal(path.isAbsolute(result.path), true);
});

test('generated adapter reports the selected API provider and refuses an absent symbol', t => {
  if (spawnSync(python, ['--version'], { windowsHide: true }).status !== 0) return t.skip('Python unavailable');
  if (spawnSync('gcc', ['--version'], { windowsHide: true }).status !== 0) return t.skip('C compiler unavailable');
  const temp = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temp, 'corepilot-loader-test-'));
  assert.ok(path.resolve(root).startsWith(temp + path.sep));
  try {
    const support = path.join(root, 'support'), correctness = path.join(root, 'correctness'), benchmark = path.join(root, 'benchmark');
    for (const folder of [support, correctness, benchmark]) fs.mkdirSync(folder);
    const source = path.join(root, 'library.c');
    fs.writeFileSync(source, `#if defined(_WIN32)\n#define EXPORT __declspec(dllexport)\n#else\n#define EXPORT __attribute__((visibility("default")))\n#endif\nEXPORT int candidate_kernel(void) { return 7; }\nEXPORT int baseline_kernel(void) { return 9; }\n`);
    const library = path.join(root, process.platform === 'win32' ? 'library.dll' : 'library.so');
    const compiled = spawnSync('gcc', ['-shared', '-fPIC', '-o', library, source], { encoding: 'utf8', windowsHide: true });
    assert.equal(compiled.status, 0, compiled.stderr);
    fs.writeFileSync(path.join(support, 'corepilot_test.py'), VALIDATION_PYTHON_HARNESS);
    fs.writeFileSync(path.join(root, 'test-plan.json'), JSON.stringify({ candidate_api: 'candidate_kernel', baseline_api: 'baseline_kernel' }));
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ correctness: { tolerance: {} } }));
    fs.writeFileSync(path.join(correctness, 'cases.json'), JSON.stringify({ cases: [{ case_id: 'case', parameters: {} }] }));
    fs.writeFileSync(path.join(benchmark, 'workloads.json'), JSON.stringify({ workloads: [{ workload_id: 'workload', parameters: {} }] }));
    const script = path.join(support, 'fixture.py');
    fs.writeFileSync(script, `import sys\nfrom corepilot_test import TestContext\nartifact,root=sys.argv[1:3]\nsys.argv=['fixture','case',artifact,'1',root]\nctx=TestContext.for_correctness(__file__)\ntry: ctx.emit_correctness(True)\nexcept RuntimeError: pass\nelse: raise AssertionError('An unloaded library must not produce a measurement')\nlib=ctx.load_library()\nassert lib.candidate_kernel()==7\nctx.emit_correctness(True)\nsys.argv=['fixture','sample','BASELINE','workload',artifact,'0','1',root]\nctx=TestContext.for_performance(__file__)\nlib=ctx.load_library()\nassert lib.baseline_kernel()==9\nctx.emit_performance(1.0)\nctx.plan['baseline_api']='absent_kernel'\ntry: ctx.emit_performance(1.0)\nexcept (AttributeError,RuntimeError): pass\nelse: raise AssertionError('Missing API must not produce a measurement')\n`);
    const run = spawnSync(python, [script, library, root], { encoding: 'utf8', windowsHide: true,
      env: { ...process.env, COREPILOT_TEST_ASSETS_ROOT: root, COREPILOT_TEST_SEED: '1', COREPILOT_INNER_ITERATIONS: '1', COREPILOT_TIMING_SCOPE: 'kernel' } });
    assert.equal(run.status, 0, run.stderr);
    const lines = run.stdout.trim().split(/\r?\n/);
    assert.equal(lines.length, 2);
    for (const [index, line] of lines.entries()) {
      assert.ok(line.startsWith('COREPILOT_MEASUREMENT '));
      const output = JSON.parse(line.slice('COREPILOT_MEASUREMENT '.length));
      assert.equal(output.domain_payload.artifact_identity.resolved_symbol_path, fs.realpathSync(library));
      assert.deepEqual(output.domain_payload.symbol_resolution, { api: index ? 'baseline_kernel' : 'candidate_kernel', method: 'ctypes_lookup_at_emit' });
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
