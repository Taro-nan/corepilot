/** Shared Python protocol adapter; generated code supplies library calls and reference logic. */
export const VALIDATION_PYTHON_HARNESS = `import ctypes
import hashlib
import json
import os
import pathlib
import subprocess
import sys

class _Library(ctypes.CDLL):
    def __getitem__(self, name):
        try:
            return super().__getitem__(name)
        except AttributeError as original:
            if not isinstance(name, str) or name.startswith('_'):
                raise
            if '_corepilot_cpp_symbols' not in self.__dict__:
                try:
                    exported = subprocess.run(['nm', '-D', '--defined-only', str(self._name)], text=True, capture_output=True, check=True, timeout=15)
                    symbols = sorted(set(line.split()[-1].split('@', 1)[0] for line in exported.stdout.splitlines() if line.split() and line.split()[-1].startswith('_Z')))
                    demangled = subprocess.run(['c++filt'], input='\\n'.join(symbols) + '\\n', text=True, capture_output=True, check=True, timeout=15).stdout.splitlines()
                    self.__dict__['_corepilot_cpp_symbols'] = list(zip(symbols, demangled))
                except (OSError, subprocess.SubprocessError) as error:
                    raise RuntimeError('Cannot resolve API ' + name + ': no C export; C++ export inspection needs nm and c++filt or an explicit C ABI adapter') from error
            matches = [(symbol, declaration) for symbol, declaration in self.__dict__['_corepilot_cpp_symbols'] if declaration.startswith(name + '(')]
            if len(matches) != 1:
                detail = 'ambiguous C++ overloads' if matches else 'no matching exported function'
                raise RuntimeError('Cannot resolve API ' + name + ': ' + detail + '; use an explicit ABI adapter for this signature') from original
            symbol, declaration = matches[0]
            function = super().__getitem__(symbol)
            self.__dict__.setdefault('_corepilot_api_resolutions', {})[name] = {'symbol': symbol, 'declaration': declaration}
            return function

class TestContext:
    def __init__(self, script_file, correctness):
        args = sys.argv[1:]
        if len(args) != (4 if correctness else 7):
            raise ValueError("Unexpected test entrypoint arguments")
        self.correctness = correctness
        if correctness:
            self.subject_id, artifact, threads, runtime = args
            self.phase, self.role, self.sample_index = "sample", "EVALUATOR", None
        else:
            self.phase, self.role, self.subject_id, artifact, index, threads, runtime = args
            self.sample_index = int(index)
        self.artifact_path = str(pathlib.Path(artifact).resolve(strict=True))
        self.script_path = str(pathlib.Path(script_file).resolve(strict=True))
        self.runtime_root = pathlib.Path(runtime)
        self.threads = int(threads)
        self.assets_root = pathlib.Path(os.environ["COREPILOT_TEST_ASSETS_ROOT"])
        self.plan = json.loads((self.assets_root / "test-plan.json").read_text())
        manifest = json.loads((self.assets_root / "manifest.json").read_text())
        self.tolerance = manifest["correctness"]["tolerance"]
        inventory_file = "correctness/cases.json" if correctness else "benchmark/workloads.json"
        inventory_key, id_key = ("cases", "case_id") if correctness else ("workloads", "workload_id")
        entries = json.loads((self.assets_root / inventory_file).read_text())[inventory_key]
        self.entry = next(item for item in entries if item[id_key] == self.subject_id)
        self.parameters = dict(self.entry["parameters"])
        self.input_id = self.entry.get("execution", {}).get("input_id", self.subject_id)
        recipe_file = self.assets_root / ("correctness/input-generation.json" if correctness else "benchmark/input-generation.json")
        recipes = json.loads(recipe_file.read_text())["inputs"] if recipe_file.is_file() else {}
        self.input_generation = recipes.get(self.input_id, "")
        self.seed = int(os.environ["COREPILOT_TEST_SEED"])
        self.inner_iterations = int(os.environ["COREPILOT_INNER_ITERATIONS"])
        self.timing_scope = os.environ["COREPILOT_TIMING_SCOPE"]

    @classmethod
    def for_correctness(cls, script_file):
        return cls(script_file, True)

    @classmethod
    def for_performance(cls, script_file):
        return cls(script_file, False)

    def load_library(self):
        self._library = _Library(self.artifact_path)
        return self._library

    @staticmethod
    def sha256_file(filename):
        digest = hashlib.sha256()
        with open(filename, "rb") as source:
            for chunk in iter(lambda: source.read(1048576), b""):
                digest.update(chunk)
        return digest.hexdigest()

    def emit_correctness(self, passed, diagnostics=None):
        if type(passed) is not bool:
            raise ValueError("Correctness requires a boolean reference comparison")
        self._emit("PASS" if passed else "FAIL", diagnostics)

    def emit_performance(self, seconds_per_call, diagnostics=None):
        if self.phase != "warmup":
            self._emit(seconds_per_call, diagnostics)

    def _emit(self, value, diagnostics):
        payload = {"parameters": self.parameters, "input_id": self.input_id, "seed": self.seed,
            "artifact_identity": {"sha256": self.sha256_file(self.artifact_path),
                "input_path": self.artifact_path, "resolved_symbol_path": self.artifact_path},
            "evaluator_binary_identity" if self.correctness else "benchmark_identity": {"sha256": self.sha256_file(self.script_path)},
            "diagnostics": diagnostics}
        if hasattr(self, '_library'):
            payload['api_resolutions'] = self._library.__dict__.get('_corepilot_api_resolutions', {})
        print("COREPILOT_MEASUREMENT " + json.dumps({"kind": "CORRECTNESS_CASE" if self.correctness else "PERFORMANCE_SAMPLE",
            "role": self.role, "subject_id": self.subject_id, "sample_index": self.sample_index, "value": value,
            "unit": None if self.correctness else "seconds", "validity": "VALID", "domain_payload": payload}))
`;

export function generatedTestEntrypoint(kind: 'correctness' | 'performance'): string {
  return `#!/bin/sh
set -eu
if [ "$#" -ne ${kind === 'correctness' ? 4 : 7} ]; then printf '%s\\n' 'Invalid ${kind} arguments' >&2; exit 2; fi
: "\${COREPILOT_TEST_ASSETS_ROOT:?Test assets directory is required}"
exec python3 "$COREPILOT_TEST_ASSETS_ROOT/support/test-${kind}.py" "$@"
`;
}
