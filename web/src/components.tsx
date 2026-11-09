import React from 'react';

export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    home: <><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z" /></>,
    tasks: <><path d="M8 5h13M8 12h13M8 19h13M3 5h.1M3 12h.1M3 19h.1" /></>,
    chart: <><path d="M4 20h17M7 16V9m5 7V4m5 12v-5" /></>,
    report: <><path d="M14 3H5v18h14V8Zm0 0v5h5M8 12h8M8 16h6" /></>,
    settings: <><path d="m10 3-1 3-3 1-2 3 2 2v3l3 2 1 3h4l1-3 3-2v-3l2-2-2-3-3-1-1-3Z" /><circle cx="12" cy="12" r="3" /></>,
    server: <><rect x="3" y="3" width="18" height="7" rx="2" /><rect x="3" y="14" width="18" height="7" rx="2" /><path d="M7 6.5h.1m0 11h.1M12 6.5h5m-5 11h5" /></>,
    plus: <path d="M12 5v14M5 12h14" />, arrow: <path d="m9 5 7 7-7 7" />,
    code: <><path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 20" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    logout: <><path d="M9 4H4v16h5m5-15 7 7-7 7m-6-7h13" /></>,
    folder: <path d="M3 7V5h7l2 3h9v12H3Z" />,
    'folder-filled': <><path d="M2.5 8V5.5A1.5 1.5 0 0 1 4 4h5l2.5 3H20a1.5 1.5 0 0 1 1.5 1.5V10H2.5Z" fill="#e9b94e" stroke="#d4a33b" /><path d="M2.5 9.5H22l-2 10H4Z" fill="#f7d472" stroke="#dfb64e" /></>,
    drive: <><rect x="3" y="13" width="18" height="7" rx="2" /><path d="m3 15 3-11h12l3 11M7 16.5h.1M11 16.5h6" /></>,
    back: <path d="m14 6-6 6 6 6" />, up: <path d="m6 14 6-6 6 6" />,
    forward: <path d="M4 12h16m-6-6 6 6-6 6" />,
    edit: <><path d="m16 3 5 5L9 20l-6 1 1-6Z" /><path d="m14 5 5 5" /></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 7a7 7 0 0 1 12-2l2 2M4 17l2 2a7 7 0 0 0 12-2" /></>,
    check: <path d="m5 12 4 4 10-10" />, download: <><path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4" /></>,
    close: <path d="m6 6 12 12M6 18 18 6" />, search: <><circle cx="10" cy="10" r="6" /><path d="m15 15 6 6" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.tasks}</svg>;
}
export function Brand() { return <div className="brand"><svg width="31" height="35" viewBox="0 0 32 36" fill="none" aria-hidden="true"><path d="m16 2 13 7v6l-13-7-7 4 7 4 13 7v6l-13 7-13-7v-6l13 7 7-4-7-4-13-7V9Z" fill="#246bfe" /></svg><span>CorePilot</span></div>; }
const labels: Record<string, string> = { CREATED: '已创建', GENERATING: '优化中', WAITING_APPROVAL: '待人工审阅', DELIVERABLE: '已交付', PERFORMANCE_THRESHOLD_NOT_MET: '未达性能目标', FAILED: '失败', CANCELLED: '已取消', NO_CANDIDATE: '尚无候选', VALIDATION_BLOCKED: '验证受阻', BUDGET_EXHAUSTED: '预算已用完', INTERRUPTED: '已中断', PROPOSED: '已提出', REJECTED: '未采纳', INCONCLUSIVE: '无结论', ABANDONED: '已放弃', SUCCEEDED: '执行完成', RUNNING: '运行中', PENDING: '等待执行', UNKNOWN: '待核对', VALID: '有效', INVALID: '无效', PASSED: '通过', PASS: '通过', INCOMPLETE: '不完整', NOT_EXECUTED: '未执行', FROZEN: '已冻结', APPROVED: '已批准', QUALIFIED: '已验证可用', DRAFT: '待完善' };
labels.TARGET_VALIDATED = '目标机验证完成，待确认';
export function label(value?: string | null) { return value === 'VALIDATION_BLOCKED' ? '验证受阻，可重试' : value === 'NO_CANDIDATE' ? '调查结束，未提交候选' : value === 'BUDGET_EXHAUSTED' ? '预算已用完，可继续' : value === 'INTERRUPTED' ? '已中断，可继续' : value ? labels[value] ?? value : '—'; }
export function Badge({ value, children }: { value?: string | null; children?: React.ReactNode }) {
  const color = ['PASSED', 'PASS', 'VALID', 'QUALIFIED', 'APPROVED', 'DELIVERABLE'].includes(value ?? '') ? 'green' : ['FAILED', 'INVALID'].includes(value ?? '') ? 'red' : ['GENERATING', 'RUNNING', 'WAITING_APPROVAL', 'CREATED'].includes(value ?? '') ? 'amber' : 'gray';
  return <span className={`badge ${color}`}><i />{children ?? label(value)}</span>;
}
export function Panel({ title, aside, children, className = '' }: { title: string; aside?: React.ReactNode; children: React.ReactNode; className?: string }) { return <section className={`panel ${className}`}><div className="panel-head"><h2>{title}</h2>{aside}</div>{children}</section>; }
export function Empty({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) { return <div className="empty"><div className="empty-icon"><Icon name="folder" size={30} /></div><h3>{title}</h3><p>{description}</p>{action}</div>; }
export function Modal({ title, children, onClose, wide = false, className = '', footer, returnFocus }: { title: string; children: React.ReactNode; onClose: () => void; wide?: boolean; className?: string; footer?: React.ReactNode; returnFocus?: HTMLElement | null }) {
  const ref = React.useRef<HTMLDialogElement>(null);
  const trigger = React.useRef(returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  const titleId = React.useId();
  React.useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => { if (dialog?.open) dialog.close(); queueMicrotask(() => { if (trigger.current?.isConnected) trigger.current.focus({ preventScroll: true }); }); }; }, []);
  return <dialog ref={ref} aria-labelledby={titleId} className={(wide ? 'wide ' : '') + className} onCancel={e => { e.preventDefault(); onClose(); }}><div className="modal-head"><h2 id={titleId}>{title}</h2><button type="button" className="icon-btn" aria-label="关闭" onClick={onClose}><Icon name="close" /></button></div><div className="modal-body">{children}</div>{footer && <div className="modal-footer">{footer}</div>}</dialog>;
}
export function Feedback({ text, bad = false }: { text: string; bad?: boolean }) {
  const long = bad && (text.length > 320 || text.split('\n').length > 4);
  const first = text.split('\n').find(line => line.trim() && !/^\s*(at |file:\/\/)/.test(line))?.slice(0, 220) ?? '操作未完成';
  return <div className={`feedback ${bad ? 'bad' : 'good'}`} role={bad ? 'alert' : 'status'}><Icon name={bad ? 'report' : 'check'} size={17} /><div>{long ? <><p>{first}</p><p className="feedback-next">请核对当前操作的配置与执行阶段。完整原因和命令输出可在下方查看，当前输入仍保留。</p><details><summary>查看完整错误</summary><pre>{text}</pre></details></> : text}</div></div>;
}

/** Native details keeps advanced inputs mounted and supports keyboard interaction. */
export function Disclosure({ title, summary, modified = false, defaultOpen = false, children, className = '' }: {
  title: string; summary?: React.ReactNode; modified?: boolean; defaultOpen?: boolean; children: React.ReactNode; className?: string;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  return <details className={'disclosure ' + className} open={open} onToggle={event => setOpen(event.currentTarget.open)} onInvalidCapture={event => { event.currentTarget.open = true; setOpen(true); }}>
    <summary><span className="disclosure-title">{title}</span>{modified && <span className="modified-mark">已调整</span>}{summary && <span className="disclosure-summary">{summary}</span>}</summary>
    <div className="disclosure-body">{children}</div>
  </details>;
}

export function CopyValue({ value, label: name = '标识' }: { value: string; label?: string }) {
  const [state, setState] = React.useState('');
  React.useEffect(() => { if (!state) return; const timer = setTimeout(() => setState(''), 2500); return () => clearTimeout(timer); }, [state]);
  return <span className="copy-value"><code>{value}</code><button type="button" className="text-btn" aria-label={'复制' + name} onClick={() => {
    if (!navigator.clipboard) { setState('复制失败，请选择文本复制'); return; }
    void navigator.clipboard.writeText(value).then(() => setState('已复制')).catch(() => setState('复制失败，请选择文本复制'));
  }}>复制</button><span className="sr-only" role="status">{state}</span>{state && <small aria-hidden="true">{state}</small>}</span>;
}
export function Field({ label: text, children, help }: { label: React.ReactNode; children: React.ReactNode; help?: string }) {
  const fieldId = React.useId(), helpId = fieldId + '-help';
  let controlId = fieldId, assigned = false;
  const associate = (node: React.ReactNode): React.ReactNode => {
    if (assigned || !React.isValidElement(node)) return node;
    const element = node as React.ReactElement<{ id?: string; children?: React.ReactNode; 'aria-describedby'?: string }>;
    if (typeof element.type === 'string' && ['input', 'select', 'textarea'].includes(element.type)) {
      assigned = true; controlId = element.props.id ?? fieldId;
      return React.cloneElement(element, { id: controlId, 'aria-describedby': [element.props['aria-describedby'], help ? helpId : ''].filter(Boolean).join(' ') || undefined });
    }
    if (typeof element.type === 'string' || element.type === React.Fragment) return React.cloneElement(element, {}, React.Children.map(element.props.children, associate));
    return node;
  };
  const controls = React.Children.map(children, associate);
  return <div className="field"><label htmlFor={assigned ? controlId : undefined}>{text}</label>{controls}{help && <small id={helpId}>{help}</small>}</div>;
}
export function Metric({ title, value, note, good, onClick }: { title: string; value: React.ReactNode; note?: string; good?: boolean; onClick?: () => void }) {
  const content = <><span>{title}</span><strong className={good ? 'success-text' : ''}>{value}</strong>{note && <small>{note}</small>}</>;
  return onClick ? <button type="button" className="metric metric-action" onClick={onClick} aria-label={`查看${title}：${String(value)}`}>{content}<Icon name="arrow" size={16} /></button> : <div className="metric">{content}</div>;
}
export function download(name: string, content: string) { const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' })); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
export function time(value?: string) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'; }
