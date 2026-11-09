import type { CreateTestingTask, TestingAsset, TestingAssetFile, TestingPlanPreview, TestingPlanRef, TestingTaskDetails, TestingTaskRecord } from '../contracts/testing.js';

type JsonRequest = (method: string, path: string, body?: Record<string, unknown>, headers?: Record<string, string>) => Promise<unknown>;
type BinaryUpload = (path: string, body: Uint8Array | Blob) => Promise<unknown>;

/** Web and CLI consume the same persisted testing use case. */
export class TestingClient {
  constructor(private readonly request: JsonRequest, private readonly upload: BinaryUpload) {}
  list(): Promise<{ tasks: TestingTaskRecord[] }> { return this.request('GET', '/v1/testing-tasks') as Promise<{ tasks: TestingTaskRecord[] }>; }
  start(input: CreateTestingTask, requestId?: string): Promise<{ task: TestingTaskRecord }> {
    return this.request('POST', '/v1/testing-tasks', { ...input }, requestId ? { 'idempotency-key': requestId } : undefined) as Promise<{ task: TestingTaskRecord }>;
  }
  get(id: string): Promise<TestingTaskDetails> { return this.request('GET', `/v1/testing-tasks/${encodeURIComponent(id)}`) as Promise<TestingTaskDetails>; }
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
