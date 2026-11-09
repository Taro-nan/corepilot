import { useEffect, useState } from 'react';
import type { OptimizationConfig } from '../../src/config/optimization-config';
import type { DiscoveredModel } from '../../src/model/model-discovery';
import { request } from './api';

type Connection = Pick<OptimizationConfig['model'], 'endpoint' | 'api_key' | 'proxy'>;

/** Discover from unsaved connection settings; late responses cannot replace a newer list. */
export function useModelDiscovery(projectId: string, connection: Connection | null, enabled: boolean) {
  const connectionKey = connection ? JSON.stringify(connection) : '';
  const key = `${projectId}:${connectionKey}`;
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState({ key: '', models: [] as DiscoveredModel[], loading: false, error: '' });
  useEffect(() => {
    if (!enabled || !connectionKey) return;
    const model: Connection = JSON.parse(connectionKey);
    try {
      if (!['http:', 'https:'].includes(new URL(model.endpoint).protocol)) throw new Error();
    } catch {
      setResult({ key, models: [], loading: false, error: '请填写有效的 http(s) Endpoint，模型列表会自动加载。' });
      return;
    }
    const controller = new AbortController();
    setResult({ key, models: [], loading: true, error: '' });
    const timer = setTimeout(() => {
      request<{ models: DiscoveredModel[] }>(`/v1/projects/${projectId}/models`, 'POST', { model }, controller.signal)
        .then(data => { if (!controller.signal.aborted) setResult({ key, models: data.models, loading: false, error: '' }); })
        .catch(error => { if (!controller.signal.aborted) setResult({ key, models: [], loading: false, error: (error as Error).message }); });
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [projectId, connectionKey, key, enabled, revision]);
  return {
    ...(result.key === key ? result : { models: [], loading: enabled && !!connectionKey, error: '' }),
    refresh: () => setRevision(value => value + 1),
  };
}
