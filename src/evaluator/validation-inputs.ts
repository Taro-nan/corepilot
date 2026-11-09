import type { ValidationCorrectnessInput, ValidationPerformanceInput } from '../contracts/validation-assets.js';

type Input = ValidationCorrectnessInput | ValidationPerformanceInput;
type Kind = 'cases' | 'workloads';

export class ValidationInputError extends Error {
  constructor(readonly field: string, message: string) {
    super(message);
    this.name = 'ValidationInputError';
  }
}

export function parseValidationInputs(value: unknown, kind: 'cases', previous?: readonly Input[]): ValidationCorrectnessInput[];
export function parseValidationInputs(value: unknown, kind: 'workloads', previous?: readonly Input[]): ValidationPerformanceInput[];
export function parseValidationInputs(value: unknown, kind: Kind, previous?: readonly Input[]): Input[];
/** Shared by the browser JSON editor and every application save entry point. */
export function parseValidationInputs(value: unknown, kind: Kind, previous: readonly Input[] = []): Input[] {
  const label = kind === 'cases' ? '正确性用例' : '性能负载';
  if (!Array.isArray(value) || value.length < 1 || value.length > 200) {
    throw new ValidationInputError(kind, `${label}需要包含 1～200 行。`);
  }
  const ids = new Map<string, number>();
  return value.map((entry: unknown, index): Input => {
    const field = `${kind}[${index}]`, row = `第 ${index + 1} 行${label}`;
    const fail = (name: string, message: string): never => { throw new ValidationInputError(name ? `${field}.${name}` : field, `${row}：${message}`); };
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('', '每行必须是包含名称和 parameters 的对象。');
    const item = entry as Record<string, unknown>;
    const idKey = kind === 'cases' ? 'case_id' : 'workload_id';
    const id = item[idKey];
    if (typeof id !== 'string' || !id.trim()) fail(idKey, `请填写名称（${idKey}）。`);
    if (!/^[a-zA-Z0-9_.-]+$/.test(id as string)) fail(idKey, '名称只支持英文字母、数字、点、下划线和短横线，例如 small-128；不能包含空格或中文。');
    const inputId = id as string;
    if (ids.has(inputId)) fail(idKey, `名称“${inputId}”与第 ${ids.get(inputId)! + 1} 行重复，请使用不同名称。`);
    ids.set(inputId, index);
    const prior = previous.find(input => ('case_id' in input ? input.case_id : input.workload_id) === inputId);
    const threads = item.threads === undefined ? prior?.threads ?? 1 : item.threads;
    if (typeof threads !== 'number' || !Number.isInteger(threads) || threads < 1) fail('threads', '线程数 threads 必须是大于等于 1 的整数。');
    if (!item.parameters || typeof item.parameters !== 'object' || Array.isArray(item.parameters)) {
      fail('parameters', '输入参数 parameters 必须是对象，例如 {"length":128}；无参数时填写 {}。');
    }
    const parameters = item.parameters as Record<string, unknown>;
    for (const [name, parameter] of Object.entries(parameters)) {
      if (typeof parameter !== 'string' && typeof parameter !== 'boolean' && !(typeof parameter === 'number' && Number.isFinite(parameter))) {
        fail(`parameters.${name}`, `参数“${name}”只能填写有限数字、文本或开关，不能使用数组、对象或 null；多个尺寸请拆成多行，复合值请拆成独立参数。`);
      }
    }
    const recipe = item.input_generation;
    if (recipe !== undefined && (typeof recipe !== 'string' || recipe.length > 6000)) fail('input_generation', '数据生成规则必须是 6000 字符以内的文本。');
    const common = { threads: threads as number, parameters: { ...parameters } as Record<string, string | number | boolean>,
      ...(recipe === undefined ? {} : { input_generation: (recipe as string).trim() }) };
    if (kind === 'cases') return { ...common, case_id: inputId };
    const priorWorkload = prior && 'workload_id' in prior ? prior : undefined;
    const critical = item.critical === undefined ? priorWorkload?.critical ?? false : item.critical;
    const weight = item.weight === undefined ? priorWorkload?.weight ?? 1 : item.weight;
    if (typeof critical !== 'boolean') fail('critical', '关键负载标记 critical 必须是 true 或 false。');
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) fail('weight', '权重 weight 必须是大于 0 的有限数字；不需要特殊权重时填写 1。');
    return { ...common, workload_id: inputId, critical: critical as boolean, weight: weight as number };
  });
}
