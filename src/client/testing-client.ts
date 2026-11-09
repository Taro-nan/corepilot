import type { CreateTestingTask, TestingAsset, TestingAssetFile, TestingPlanPreview, TestingPlanRef, TestingRequestStatus, TestingTaskDetails, TestingTaskRecord } from '../contracts/testing.js';
import { CONTROL_GUARD_HEADER, type ControlIdentity } from '../contracts/control-identity.js';
import { controlRoute } from './control-identity-route.js';

type JsonRequest = (method: string, path: string, body?: Record<string, unknown>, headers?: Record<string, string>) => Promise<unknown>;
type BinaryUpload = (path: string, body: Uint8Array | Blob) => Promise<unknown>;

/** Web and CLI consume the same persisted testing use case. */
export class TestingClient {
  constructor(private readonly request: JsonRequest, private readonly upload: BinaryUpload) {}
  list(): Promise<{ tasks: TestingTaskRecord[]; observation?: TestingTaskDetails['observation']; identity_notice?: string }> { return this.request('GET', '/v1/testing-tasks') as Promise<{ tasks: TestingTaskRecord[]; observation?: TestingTaskDetails['observation']; identity_notice?: string }>; }
  start(input: CreateTestingTask, requestId?: string, identity?: ControlIdentity): Promise<{ task: TestingTaskRecord }> {
    return this.request('POST', identity ? controlRoute(identity, '/testing-tasks') : '/v1/testing-tasks', { ...input },
      { ...(requestId === undefined ? {} : { 'idempotency-key': requestId }), ...(identity ? { [CONTROL_GUARD_HEADER]: '1' } : {}) }) as Promise<{ task: TestingTaskRecord }>;
  }
  requestStatus(requestId: string, identity?: ControlIdentity): Promise<TestingRequestStatus> {
    return this.request('GET', identity ? controlRoute(identity, '/testing-requests') : '/v1/testing-requests', undefined,
      { 'idempotency-key': requestId, ...(identity ? { [CONTROL_GUARD_HEADER]: '1' } : {}) }) as Promise<TestingRequestStatus>;
  }
  closeRequest(requestId: string, identity?: ControlIdentity): Promise<TestingRequestStatus> {
    return this.request('POST', identity ? controlRoute(identity, '/testing-requests/close') : '/v1/testing-requests/close', {},
      { 'idempotency-key': requestId, ...(identity ? { [CONTROL_GUARD_HEADER]: '1' } : {}) }) as Promise<TestingRequestStatus>;
  }
  get(id: string, identity?: ControlIdentity): Promise<TestingTaskDetails> {
    const path = `/testing-tasks/${encodeURIComponent(id)}`;
    return this.request('GET', identity ? controlRoute(identity, path) : '/v1' + path, undefined,
      identity ? { [CONTROL_GUARD_HEADER]: '1' } : undefined) as Promise<TestingTaskDetails>;
  }
  cancel(id: string): Promise<TestingTaskDetails> { return this.request('POST', `/v1/testing-tasks/${encodeURIComponent(id)}/cancel`, {}) as Promise<TestingTaskDetails>; }
  preview(plan: TestingPlanRef): Promise<{ plan: TestingPlanPreview }> { return this.request('POST', '/v1/testing-plans/preview', { ...plan }) as Promise<{ plan: TestingPlanPreview }>; }
  listAssets(): Promise<{ assets: TestingAsset[] }> { return this.request('GET', '/v1/testing-assets') as Promise<{ assets: TestingAsset[] }>; }
  createAsset(input: { name: string; version?: string }): Promise<{ asset: TestingAsset }> {
    return this.request('POST', '/v1/testing-assets', input) as Promise<{ asset: TestingAsset }>;
  }
  uploadAssetFile(id: string, relativePath: string, bytes: Uint8Array | Blob): Promise<{ file: TestingAssetFile }> {
    return this.upload(`/v1/testing-assets/${encodeURIComponent(id)}/files?path=${encodeURIComponent(relativePath)}`, bytes) as Promise<{ file: TestingAssetFile }>;
  }
  finalizeAsset(id: string, entryPath: string): Promise<{ asset: TestingAsset }> {
    return this.request('POST', `/v1/testing-assets/${encodeURIComponent(id)}/finalize`, { entry_path: entryPath }) as Promise<{ asset: TestingAsset }>;
  }
}
