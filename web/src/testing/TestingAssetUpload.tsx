import React, { useState } from 'react';
import type { TestingAsset } from '../../../src/contracts/testing';
import { api } from '../api';
import { Feedback, Field, Modal } from '../components';

interface UploadFile { file: File; path: string }

export function TestingAssetUpload({ close, added }: { close: () => void; added: (asset: TestingAsset) => void }) {
  const [name, setName] = useState('');
  const [version, setVersion] = useState('');
  const [files, setFiles] = useState<UploadFile[]>([]);
  const [skipped, setSkipped] = useState(0);
  const [entry, setEntry] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  function select(list: FileList | null) {
    const all = Array.from(list ?? []);
    const selected = all.filter(file => /\.(?:so(?:\.[A-Za-z0-9_.+-]+)?|h|hpp|hh)$/.test(file.name))
      .map(file => ({ file, path: file.webkitRelativePath ? file.webkitRelativePath.split('/').slice(1).join('/') : file.name }));
    setSkipped(all.length - selected.length);
    setFiles(selected); setEntry(selected.find(item => /\.so(?:\.|$)/.test(item.path))?.path ?? ''); setError('');
    if (!name && selected.length) setName(selected[0].file.webkitRelativePath.split('/')[0] || selected[0].file.name);
  }
  async function upload(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      if (!files.length || !entry) throw new Error('请选择库文件，并指定本次调用的动态库入口。');
      const { asset } = await api.testing.createAsset({ name: name.trim(), version: version.trim() || undefined });
      for (const [index, item] of files.entries()) {
        setProgress(`正在上传 ${index + 1} / ${files.length}：${item.path}`);
        await api.testing.uploadAssetFile(asset.asset_id, item.path, item.file);
      }
      setProgress('正在核对文件和固定库包版本…');
      const result = await api.testing.finalizeAsset(asset.asset_id, entry); added(result.asset);
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); setProgress(''); }
  }
  return <Modal title="上传测试库包" onClose={() => { if (!busy) close(); }}>
    <form onSubmit={event => void upload(event)}>
      <fieldset disabled={busy} className="config-fields">
        <div className="field-grid"><Field label="库包名称"><input required maxLength={160} value={name} onChange={event => setName(event.target.value)} placeholder="例如：示例数学库" /></Field>
          <Field label="版本（可选）"><input maxLength={160} value={version} onChange={event => setVersion(event.target.value)} placeholder="用于区分版本" /></Field></div>
        <div className="testing-upload-options">
          <Field label="选择库包文件"><input type="file" multiple onChange={event => select(event.target.files)} /></Field>
          <Field label="或选择已解压的库目录"><input type="file" multiple {...{ webkitdirectory: '' }} onChange={event => select(event.target.files)} /></Field>
        </div>
        <p className="hint">上传动态库、依赖和需要的头文件，保留目录结构。本次固定的文件不会覆盖项目基线。</p>
        {!!skipped && <p className="hint" role="status">已忽略 {skipped} 个其他文件，仅上传 .so 动态库与头文件。</p>}
        {!!files.length && <><Field label="动态库入口"><select required value={entry} onChange={event => setEntry(event.target.value)}>
          <option value="" disabled>选择要调用的 .so 文件</option>{files.filter(item => /\.so(?:\.|$)/.test(item.path)).map(item => <option key={item.path} value={item.path}>{item.path}</option>)}
        </select></Field><p className="hint">已选择 {files.length} 个文件 · {(files.reduce((total, item) => total + item.file.size, 0) / 1024 ** 2).toFixed(1)} MB</p></>}
      </fieldset>
      {progress && <p role="status">{progress}</p>}{error && <Feedback text={error} bad />}
      <div className="form-actions"><button type="button" disabled={busy} onClick={close}>返回</button><button className="primary" disabled={busy || !files.length || !entry}>{busy ? '正在上传…' : '上传并固定版本'}</button></div>
    </form>
  </Modal>;
}
