export type ModelSourceId = 'deepseek' | 'qwen' | 'glm' | 'kimi' | 'doubao' | 'mimo' | 'openai' | 'custom';

export interface ModelSource {
  id: ModelSourceId;
  label: string;
  /** Built-in sources keep their OpenAI-compatible endpoint internal. */
  endpoint?: string;
  /** Developer-console URL shown next to the API key prompt. */
  developerUrl?: string;
}

/** Stable provider presets; model ids are always discovered from the endpoint. */
export const MODEL_SOURCES: readonly ModelSource[] = [
  { id: 'deepseek', label: 'DeepSeek - 深度求索', endpoint: 'https://api.deepseek.com/v1', developerUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'qwen', label: 'Qwen - 阿里云百炼', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1', developerUrl: 'https://bailian.console.aliyun.com/?tab=model#/api-key' },
  { id: 'glm', label: 'GLM - 智谱AI', endpoint: 'https://open.bigmodel.cn/api/paas/v4', developerUrl: 'https://open.bigmodel.cn/usercenter/apikeys' },
  { id: 'kimi', label: 'Kimi - 月之暗面', endpoint: 'https://api.moonshot.cn/v1', developerUrl: 'https://platform.moonshot.cn/console/api-keys' },
  { id: 'doubao', label: 'Doubao - 火山引擎', endpoint: 'https://ark.cn-beijing.volces.com/api/v3', developerUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey' },
  { id: 'mimo', label: 'MiMo - 小米', endpoint: 'https://api.xiaomimimo.com/v1', developerUrl: 'https://platform.xiaomimimo.com/#/console/api-keys' },
  { id: 'openai', label: 'GPT - OpenAI', endpoint: 'https://api.openai.com/v1', developerUrl: 'https://platform.openai.com/api-keys' },
  { id: 'custom', label: '自定义 OpenAI-compatible 模型' },
];

export function modelSource(id: ModelSourceId): ModelSource {
  const source = MODEL_SOURCES.find((item) => item.id === id);
  if (!source) throw new Error(`未知模型来源：${id}`);
  return source;
}
