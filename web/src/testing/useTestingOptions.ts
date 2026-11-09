import { useCallback, useEffect, useState } from 'react';
import type { ExecutionMachineSummary } from '../../../src/contracts/execution-machine';
import type { TestingAsset } from '../../../src/contracts/testing';
import type { CatalogItem } from '../Configuration';
import { api, request } from '../api';

interface TestingOptions { machines: ExecutionMachineSummary[]; assets: TestingAsset[]; catalog: CatalogItem[] }

/** Reload choices when entering creation, including after editing a test plan. */
export function useTestingOptions(active: boolean) {
  const [data, setData] = useState<TestingOptions | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt(value => value + 1), []);
  const addAsset = useCallback((asset: TestingAsset) => setData(current => current ? {
    ...current, assets: [...current.assets.filter(item => item.asset_id !== asset.asset_id), asset],
  } : current), []);

  useEffect(() => {
    if (!active) return;
    let current = true;
    setData(null); setError('');
    void Promise.all([api.listExecutionMachines(), api.testing.listAssets(), request<{ packages: CatalogItem[] }>('/v1/catalog')])
      .then(([machines, assets, catalog]) => {
        if (current) setData({ machines: machines.machines, assets: assets.assets, catalog: catalog.packages });
      }).catch(failure => { if (current) setError((failure as Error).message); });
    return () => { current = false; };
  }, [active, attempt]);

  return { data, error, retry, addAsset };
}
