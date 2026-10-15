import { RunnerClient } from '../client/runner-client.js';
import {
  RUNNER_PROTOCOL_VERSION,
  type CancelExperimentResponse,
  type ExperimentCommandsResponse,
  type ExperimentExecutionPlan,
  type ExperimentMeasurementsResponse,
  type ExperimentStatusResponse,
  type RunnerHealth,
  type RunnerMachineInfo,
  type SubmitExperimentResponse,
} from '../contracts/runner-rpc.js';

/** Thin Optimization Runtime boundary over an Execution Plane. */
export interface ExperimentExecutionBackend {
  readonly mode: 'rpc';
  preflight(signal?: AbortSignal): Promise<{ health: RunnerHealth; machine: RunnerMachineInfo }>;
  submitExperiment(plan: ExperimentExecutionPlan, signal?: AbortSignal): Promise<SubmitExperimentResponse>;
  getExperiment(experimentId: string, signal?: AbortSignal): Promise<ExperimentStatusResponse>;
  reconcileExperiment(experimentId: string, signal?: AbortSignal): Promise<ExperimentStatusResponse>;
  cancelExperiment(experimentId: string, signal?: AbortSignal): Promise<CancelExperimentResponse>;
  getCommandExecutions(experimentId: string, signal?: AbortSignal): Promise<ExperimentCommandsResponse>;
  getMeasurements(experimentId: string, signal?: AbortSignal): Promise<ExperimentMeasurementsResponse>;
}

/** RPC implementation. It contains no optimization workflow or fallback. */
export class RunnerClientExperimentExecutionBackend implements ExperimentExecutionBackend {
  readonly mode = 'rpc' as const;

  constructor(private readonly client: RunnerClient) {}

  async preflight(signal?: AbortSignal): Promise<{ health: RunnerHealth; machine: RunnerMachineInfo }> {
    const health = await this.client.health(signal);
    if (health.status !== 'READY') throw new Error(`runner '${health.runner_id}' is not ready`);
    if (health.protocol_version !== RUNNER_PROTOCOL_VERSION) {
      throw new Error(`runner protocol ${health.protocol_version} is incompatible with control protocol ${RUNNER_PROTOCOL_VERSION}`);
    }
    const machine = await this.client.machine(signal);
    return { health, machine };
  }

  submitExperiment(plan: ExperimentExecutionPlan, signal?: AbortSignal): Promise<SubmitExperimentResponse> {
    return this.client.submitExperiment(plan, signal);
  }

  getExperiment(experimentId: string, signal?: AbortSignal): Promise<ExperimentStatusResponse> {
    return this.client.getExperiment(experimentId, signal);
  }

  reconcileExperiment(experimentId: string, signal?: AbortSignal): Promise<ExperimentStatusResponse> {
    return this.client.getExperiment(experimentId, signal);
  }

  cancelExperiment(experimentId: string, signal?: AbortSignal): Promise<CancelExperimentResponse> {
    return this.client.cancelExperiment(experimentId, signal);
  }

  getCommandExecutions(experimentId: string, signal?: AbortSignal): Promise<ExperimentCommandsResponse> {
    return this.client.getCommandExecutions(experimentId, signal);
  }

  getMeasurements(experimentId: string, signal?: AbortSignal): Promise<ExperimentMeasurementsResponse> {
    return this.client.getMeasurements(experimentId, signal);
  }
}
