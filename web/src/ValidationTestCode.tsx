import React from 'react';
import type { ValidationAssetEdit, ValidationSourceFile } from '../../src/contracts/validation-assets';

type CodeAssets = Pick<ValidationAssetEdit, 'correctness_script' | 'performance_script' | 'supporting_files'>;
type Scope = 'correctness' | 'performance';

/** Show the program actually invoked by the entrypoint; uploaded standalone scripts stay visible. */
export function testProgramFile(assets: CodeAssets, scope: Scope): ValidationSourceFile {
  const entry = assets[`${scope}_script`], programPath = `support/test-${scope}.py`;
  const program = assets.supporting_files?.find(file => file.path === programPath);
  const invokesProgram = entry.split('\n').some(line => /^\s*(?:exec\s+)?python(?:3(?:\.\d+)?)?\s+/.test(line) && line.includes(programPath));
  return program && invokesProgram ? program : { path: `scripts/run-${scope}.sh`, content: entry };
}

export function ValidationTestCode({ assets, scope, open, onChange, onDownload, onExpand }: {
  assets: CodeAssets; scope: Scope; open: boolean;
  onChange: (file: ValidationSourceFile) => void;
  onDownload: (file: ValidationSourceFile) => void;
  onExpand: () => void;
}) {
  const title = scope === 'correctness' ? '正确性' : '性能';
  const program = testProgramFile(assets, scope), delegated = program.path.startsWith('support/');
  const entry = { path: `scripts/run-${scope}.sh`, content: assets[`${scope}_script`] };
  if (!delegated && /DRAFT evaluator is not executable/.test(program.content)) return <div className="test-code-source test-code-empty">
    <strong>尚未生成{title}测试程序</strong><p className="hint">点击上方 AI 生成或上传已有脚本。生成进度和缺少的信息会显示在本页；完成后在这里查看实际代码。</p>
    <details open={open}><summary>高级：自行编写{title}测试入口</summary><textarea aria-label={`${title}测试脚本`} rows={10} spellCheck={false} value="" placeholder="在这里填写完整的测试脚本" onChange={e => onChange({ ...entry, content: e.target.value })} /></details>
  </div>;
  return <div className="test-code-source">
    <details open={open}>
      <summary>查看或编辑{title}测试代码</summary>
      <div className="test-code-file"><strong>{delegated ? '测试程序' : '测试脚本'}</strong><code>{program.path}</code><span>{program.content.trimEnd().split('\n').length} 行</span></div>
      <textarea aria-label={delegated ? program.path : `${title}测试脚本`} rows={16} spellCheck={false} value={program.content} onChange={e => onChange({ ...program, content: e.target.value })} />
      <div className="form-actions test-code-file-actions"><button type="button" onClick={onExpand}>放大查看{title}代码</button><button type="button" onClick={() => onDownload(program)}>下载{title}代码</button></div>
      {delegated && <p className="hint">完整运行需要测试配置和支持文件，可保存后下载完整测试包。</p>}
    </details>
    {delegated && <details className="test-code-entry"><summary>高级：{title}启动入口</summary><p className="hint">入口检查参数并启动上方测试程序，Runner 通过它传入产物和运行条件。</p><textarea aria-label={`${title}启动入口`} rows={6} spellCheck={false} value={entry.content} onChange={e => onChange({ ...entry, content: e.target.value })} /><button type="button" onClick={() => onDownload(entry)}>下载{title}启动入口</button></details>}
  </div>;
}
