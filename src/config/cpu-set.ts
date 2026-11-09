export function expandCpuSet(value: string): number[] {
  if (!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(value)) throw new Error('CPU 集合请填写如 0 或 0-3,8-11');
  const cpus = new Set<number>();
  for (const part of value.split(',')) {
    const [lo, hi = lo] = part.split('-').map(Number);
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 0 || hi < lo || hi > 65535) throw new Error('CPU 集合范围不正确');
    for (let cpu = lo; cpu <= hi; cpu++) cpus.add(cpu);
  }
  return [...cpus].sort((a, b) => a - b);
}

export function formatCpuSet(cpus: number[]): string {
  const sorted = [...new Set(cpus)].sort((a, b) => a - b), parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const first = sorted[i]; let last = first;
    while (sorted[i + 1] === last + 1) last = sorted[++i];
    parts.push(first === last ? String(first) : `${first}-${last}`);
  }
  return parts.join(',');
}
