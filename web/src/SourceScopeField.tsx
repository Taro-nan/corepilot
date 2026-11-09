import React from 'react';
import { parseSourceScope } from '../../src/contracts/source-scope';
import { Disclosure } from './components';

export function sourceScopeFromText(include: string, exclude: string) {
  const lines = (text: string) => text.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  return parseSourceScope({ include: lines(include), exclude: lines(exclude) });
}

/** Scope is an explicit write grant, never inferred from the investigation entry. */
export function SourceScopeField({ include, exclude, onChange }: { include: string; exclude: string; onChange: (value: { include?: string; exclude?: string }) => void }) {
  return <div>
    <label className="field"><span>允许修改的源码文件或目录</span>
      <textarea required rows={3} value={include} onChange={event => onChange({ include: event.target.value })} placeholder={'每行一个相对路径，例如：\nsrc/kernel.c\nsrc/impl/'} />
      <small>填写仓库相对路径；目录以 / 结尾。目录内所有文件都可修改，请核对并排除测试和参考实现。</small>
    </label>
    <Disclosure title="排除目录或文件" summary={exclude.trim() ? '已设置排除路径' : '可选'} modified={!!exclude.trim()}>
      <label className="field"><span>禁止修改的路径</span><textarea rows={2} value={exclude} onChange={event => onChange({ exclude: event.target.value })} placeholder="每行一个文件或目录/" /></label>
    </Disclosure>
  </div>;
}
