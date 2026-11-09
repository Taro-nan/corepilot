import fs from 'node:fs';
import os from 'node:os';

function read(filename: string) { try { return fs.readFileSync(filename, 'utf8').trim(); } catch { return null; } }
function numeric(filename: string) { const value = read(filename); return value !== null && Number.isFinite(Number(value)) ? Number(value) : null; }

/** Observation only; unavailable kernel counters remain unknown. */
export function observeMeasurementEnvironment() {
  return { recorded_at: new Date().toISOString(), platform: process.platform,
    load_average: process.platform === 'linux' ? os.loadavg() : null, free_memory_bytes: os.freemem(),
    cpu0: { governor: read('/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor'),
      frequency_khz: numeric('/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq'),
      thermal_throttle_count: numeric('/sys/devices/system/cpu/cpu0/thermal_throttle/core_throttle_count') },
    notes: ['Observations do not prove absence of external workloads. CPU0 frequency is a platform probe, not a frequency measurement for every benchmark core.'] };
}
