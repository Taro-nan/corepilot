import { spawn } from 'node:child_process';
import type { ValidationSourceFile } from '../contracts/validation-assets.js';

// Parse only: generated code is never imported or executed on the control machine.
const CHECK_PYTHON = `import ast,builtins,json,symtable,sys
request=json.load(sys.stdin)
files=request['files']
errors=[]
for entry in files:
 try:
  table=symtable.symtable(entry['content'],entry['path'],'exec')
  declared={s.get_name() for s in table.get_symbols() if s.is_assigned() or s.is_imported() or s.is_namespace()}
  declared.update(dir(builtins)); declared.update(['__file__','__name__','__package__','__doc__','__spec__','__loader__','__builtins__','__annotations__'])
  def visit(scope):
   for s in scope.get_symbols():
    if s.is_referenced() and s.is_global() and s.get_name() not in declared:
     errors.append(entry['path']+': undefined global '+s.get_name()+'; add an explicit import or definition')
   for child in scope.get_children(): visit(child)
  visit(table)
  policy=request.get('performance')
  if policy and entry['path']=='support/test-performance.py':
   tree=ast.parse(entry['content'])
   clocks={'perf_counter','perf_counter_ns','monotonic','monotonic_ns','clock_gettime'}
   clock_aliases=set()
   parameter_aliases=set()
   iteration_aliases=set()
   for node in ast.walk(tree):
    if isinstance(node,ast.ImportFrom) and node.module=='time':
     clock_aliases.update(item.asname or item.name for item in node.names if item.name in clocks)
    if isinstance(node,ast.Assign) and isinstance(node.value,ast.Attribute) and node.value.attr=='parameters':
     parameter_aliases.update(target.id for target in node.targets if isinstance(target,ast.Name))
    if isinstance(node,ast.Assign) and any(isinstance(child,ast.Attribute) and child.attr=='inner_iterations' for child in ast.walk(node.value)):
     iteration_aliases.update(target.id for target in node.targets if isinstance(target,ast.Name))
   calls=[node for node in ast.walk(tree) if isinstance(node,ast.Call)]
   uses_clock=any(isinstance(node.func,ast.Attribute) and node.func.attr in clocks or isinstance(node.func,ast.Name) and node.func.id in clock_aliases for node in calls)
   loads_library=any(isinstance(node.func,ast.Attribute) and node.func.attr in {'load_library','CDLL','PyDLL'} for node in calls)
   loads_adapter=any(isinstance(node.func,ast.Attribute) and node.func.attr in {'CDLL','PyDLL'} for node in calls) and any(isinstance(node.func,ast.Attribute) and node.func.attr=='load_library' for node in calls)
   if policy['timing_scope']=='kernel' and uses_clock and loads_library:
    errors.append(entry['path']+': kernel timing includes Python/ctypes overhead. Put both clock reads and the library-call loop in a native adapter; Python only orchestrates. Do not add preliminary library calls or independent warmup: Runner owns warmup.')
   if policy['timing_scope']=='kernel' and loads_adapter and not any(isinstance(node,ast.BinOp) and isinstance(node.op,ast.Div) and any(isinstance(child,ast.Attribute) and child.attr=='inner_iterations' or isinstance(child,ast.Name) and child.id in iteration_aliases for child in ast.walk(node.right)) for node in ast.walk(tree)):
    errors.append(entry['path']+': native timer contract requires TOTAL loop seconds from the adapter and explicit division by ctx.inner_iterations in Python before emitting seconds PER CALL. Fix both adapter and caller consistently.')
   for node in calls:
    if not isinstance(node.func,ast.Attribute) or node.func.attr!='get' or len(node.args)<2: continue
    owner=node.func.value
    is_parameters=isinstance(owner,ast.Name) and owner.id in parameter_aliases or isinstance(owner,ast.Attribute) and owner.attr=='parameters'
    if is_parameters and isinstance(node.args[0],ast.Constant) and node.args[0].value in policy['parameter_names'] and not (isinstance(node.args[1],ast.Constant) and node.args[1].value is None):
     errors.append(entry['path']+': do not silently default saved input parameter '+str(node.args[0].value)+'. Read the saved value directly, e.g. ctx.parameters[name].')
 except SyntaxError as e:
  errors.append(entry['path']+': '+str(e))
print(json.dumps(sorted(set(errors))))
`;

export async function checkGeneratedPython(files: ValidationSourceFile[], performance?: { timing_scope: string; parameter_names: string[] }): Promise<void> {
  const python = files.filter(file => file.path.endsWith('.py'));
  if (!python.length) return;
  const errors = await new Promise<string[] | null>((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? 'python' : 'python3', ['-c', CHECK_PYTHON], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.once('error', error => (error as NodeJS.ErrnoException).code === 'ENOENT' ? resolve(null) : reject(error));
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('close', code => {
      if (code === 0) { try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Cannot read Python syntax check result')); } }
      else reject(new Error(`Python syntax checker failed: ${stderr.slice(0, 1000)}`));
    });
    child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify({ files: python, performance }));
  });
  if (errors?.length) throw new Error('Generated Python code has errors. Fix and resubmit the complete files:\n' + errors.join('\n'));
}
