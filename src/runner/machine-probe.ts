import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunnerMachineInfo } from '../contracts/runner-rpc.js';

export function probeRunnerMachine(): RunnerMachineInfo {
  const cpus = os.cpus();
  const cpuInfo = readCpuInfo();
  const productModel = firstReadable([
    '/sys/class/dmi/id/product_name',
    '/sys/firmware/devicetree/base/model',
    '/proc/device-tree/model',
  ]);
  const reportedModel = cpus[0]?.model?.trim();
  const cpuModel = reportedModel && reportedModel.toLowerCase() !== 'unknown' ? reportedModel : null;
  const cpuIdentity: RunnerMachineInfo['cpu_identity'] = {
    product_model: productModel,
    hardware: cpuInfo.get('hardware') ?? null,
    implementer: cpuInfo.get('cpu implementer') ?? null,
    architecture: cpuInfo.get('cpu architecture') ?? null,
    variant: cpuInfo.get('cpu variant') ?? null,
    part: cpuInfo.get('cpu part') ?? null,
    revision: cpuInfo.get('cpu revision') ?? null,
    midr_el1: readText('/sys/devices/system/cpu/cpu0/regs/identification/midr_el1'),
  };
  const cpuTopology = readLinuxCpuTopology(cpus.length);
  const numaSummary = readLinuxNumaSummary();
  const identitySubject = {
    hostname: os.hostname(),
    architecture: os.arch(),
    cpu_count: cpus.length,
    cpu_identity: cpuIdentity,
    cpu_topology: cpuTopology,
    numa_summary: numaSummary,
  };
  return {
    hostname: os.hostname(),
    architecture: os.arch(),
    platform: os.platform(),
    os: `${os.type()} ${os.release()}`,
    kernel: os.release(),
    cpu_count: cpus.length,
    cpu_model: cpuModel,
    machine_identity_sha256: createHash('sha256').update(stableJson(identitySubject)).digest('hex'),
    node_runtime: process.version,
    cpu_identity: cpuIdentity,
    cpu_topology: cpuTopology,
    numa_summary: numaSummary,
    resource_capabilities: {
      taskset: executableOnPath('taskset'),
      numactl: executableOnPath('numactl'),
      proc_status: fs.existsSync('/proc/self/status'),
    },
  };
}

function readLinuxNumaSummary(): RunnerMachineInfo['numa_summary'] {
  if (process.platform !== 'linux') return null;
  try {
    const onlineNodes = fs.readFileSync('/sys/devices/system/node/online', 'utf8').trim();
    const nodeCount = fs.readdirSync('/sys/devices/system/node', { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^node\d+$/.test(entry.name)).length;
    return { online_nodes: onlineNodes, node_count: nodeCount };
  } catch {
    return null;
  }
}

function readLinuxCpuTopology(cpuCount: number): RunnerMachineInfo['cpu_topology'] {
  if (process.platform !== 'linux') {
    return { online_cpus: null, possible_cpus: null, sockets: null, cores: null, threads_per_core: null, node_cpu_lists: {} };
  }
  const sockets = new Set<string>();
  const cores = new Set<string>();
  try {
    for (const entry of fs.readdirSync('/sys/devices/system/cpu', { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^cpu\d+$/.test(entry.name)) continue;
      const socket = readText(`/sys/devices/system/cpu/${entry.name}/topology/physical_package_id`);
      const core = readText(`/sys/devices/system/cpu/${entry.name}/topology/core_id`);
      if (socket !== null) sockets.add(socket);
      if (socket !== null && core !== null) cores.add(`${socket}:${core}`);
    }
  } catch { /* individual fields remain unknown */ }
  const nodeCpuLists: Record<string, string> = {};
  try {
    for (const entry of fs.readdirSync('/sys/devices/system/node', { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || !/^node\d+$/.test(entry.name)) continue;
      const cpus = readText(`/sys/devices/system/node/${entry.name}/cpulist`);
      if (cpus !== null) nodeCpuLists[entry.name] = cpus;
    }
  } catch { /* NUMA topology remains empty */ }
  const coreCount = cores.size > 0 ? cores.size : null;
  return {
    online_cpus: readText('/sys/devices/system/cpu/online'),
    possible_cpus: readText('/sys/devices/system/cpu/possible'),
    sockets: sockets.size > 0 ? sockets.size : null,
    cores: coreCount,
    threads_per_core: coreCount && cpuCount % coreCount === 0 ? cpuCount / coreCount : null,
    node_cpu_lists: nodeCpuLists,
  };
}

function readCpuInfo(): Map<string, string> {
  const output = new Map<string, string>();
  const text = readText('/proc/cpuinfo');
  if (!text) return output;
  for (const line of text.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    if (!output.has(key)) output.set(key, line.slice(separator + 1).trim());
  }
  return output;
}

function firstReadable(files: readonly string[]): string | null {
  for (const file of files) {
    const value = readText(file);
    if (value) return value;
  }
  return null;
}

function readText(file: string): string | null {
  try {
    const value = fs.readFileSync(file).toString('utf8').replace(/\0/g, '').trim();
    return value || null;
  } catch {
    return null;
  }
}

function executableOnPath(executable: string): boolean {
  const extensions = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      try {
        fs.accessSync(path.join(directory, executable + extension), fs.constants.X_OK);
        return true;
      } catch { /* try next path */ }
    }
  }
  return false;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}
