import { isControlIdentity, type ControlIdentity } from '../contracts/control-identity.js';

/** A protected route must carry both identity and the accompanying guard header. */
export function controlRoute(identity: ControlIdentity, path: string): string {
  if (!isControlIdentity(identity)) throw new Error('原请求缺少可核验的控制端身份，请联系维护者核对。');
  return `/v1/control-identities/${identity.database_id}/${identity.data_root_id}${path}`;
}
