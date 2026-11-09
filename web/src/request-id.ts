/** crypto.getRandomValues is available in supported browsers on HTTP LANs too. */
export function newRequestId(): string {
  const source = globalThis.crypto;
  if (!source || typeof source.getRandomValues !== 'function') throw new Error('浏览器无法提供安全随机数，请使用支持安全随机数的浏览器后重试。');
  const bytes = new Uint8Array(16);
  try { source.getRandomValues(bytes); }
  catch { throw new Error('浏览器无法提供安全随机数，请检查浏览器设置后重试。'); }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
