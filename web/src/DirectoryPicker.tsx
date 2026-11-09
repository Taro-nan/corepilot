import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { DirectoryListing, ProjectRecord } from '../../src/contracts/project';
import { request } from './api';
import { Icon } from './components';
import './directory-picker.css';

type Folder = DirectoryListing['directories'][number];
type Location = DirectoryListing['roots'][number];

/** Server folder picker. Selection is committed to the form only on confirmation. */
export function DirectoryPicker({ initial, projects, selected, close }: {
  initial: string; projects: ProjectRecord[]; selected: (directory: string) => void; close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const addressInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const sequence = useRef(0);
  const focusAfterNavigation = useRef(false);
  const cache = useRef(new Map<string, DirectoryListing>());
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [address, setAddress] = useState(initial);
  const [editingAddress, setEditingAddress] = useState(false);
  const [filter, setFilter] = useState('');
  const [selection, setSelection] = useState<Folder | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [history, setHistory] = useState<{ paths: string[]; index: number }>({ paths: [], index: -1 });
  const titleId = useId();
  const rowPrefix = useId();
  const folders = useMemo(() => listing?.directories.filter(folder => folder.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase())) ?? [], [listing, filter]);
  const selectionIndex = folders.findIndex(folder => folder.path === selection?.path);
  const chosenPath = selection?.path ?? listing?.path;
  const recent = [...new Map([...projects].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map(project => [project.repository_root, project])).values()].slice(0, 5);
  const common = locations.filter(location => location.kind === 'home' || location.kind === 'workspace' || location.name === '用户目录');
  const drives = locations.filter(location => location.kind === 'drive' || (!location.kind && location.name !== '用户目录'));

  function display(data: DirectoryListing, historyIndex?: number, refresh = false) {
    setListing(data); setLocations(data.roots); setAddress(data.path); setEditingAddress(false); setFilter(''); setSelection(null); setError('');
    setHistory(previous => {
      if (historyIndex !== undefined) return { ...previous, index: historyIndex };
      if (refresh || previous.paths[previous.index] === data.path) return previous;
      const paths = [...previous.paths.slice(0, previous.index + 1), data.path];
      return { paths, index: paths.length - 1 };
    });
  }

  async function browse(directory: string, options: { historyIndex?: number; refresh?: boolean; keyboard?: boolean } = {}) {
    const current = ++sequence.current;
    setBusy(true); setError('');
    focusAfterNavigation.current = options.keyboard ?? false;
    try {
      const data = !options.refresh && cache.current.get(directory) || await request<DirectoryListing>(`/v1/directories?path=${encodeURIComponent(directory)}`);
      if (current !== sequence.current) return;
      cache.current.set(data.path, data); display(data, options.historyIndex, options.refresh);
    } catch (e) {
      if (current !== sequence.current) return;
      setError((e as Error).message);
      setAddress(directory); setEditingAddress(true);
    } finally { if (current === sequence.current) setBusy(false); }
  }

  useEffect(() => {
    dialog.current?.showModal();
    let cancelled = false;
    // Load common locations even when the path typed into the project form is invalid.
    void request<DirectoryListing>('/v1/directories').then(defaults => {
      if (cancelled) return;
      cache.current.set(defaults.path, defaults); setLocations(defaults.roots);
      return browse(initial.trim() || defaults.path);
    }).catch(e => { if (!cancelled) { setError(e.message); setBusy(false); setEditingAddress(true); } });
    return () => { cancelled = true; sequence.current++; dialog.current?.close(); };
  }, []);

  useEffect(() => { if (editingAddress) { addressInput.current?.focus(); addressInput.current?.select(); } }, [editingAddress]);
  useEffect(() => {
    if (!busy && focusAfterNavigation.current) { focusAfterNavigation.current = false; grid.current?.focus(); }
  }, [busy, listing]);
  useEffect(() => {
    if (selectionIndex >= 0) document.getElementById(`${rowPrefix}-${selectionIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [selectionIndex, rowPrefix]);

  function choose() { if (!busy && !error && chosenPath) selected(chosenPath); }
  function focusAddress() { setAddress(listing?.path ?? initial); setEditingAddress(true); }
  function navigateHistory(offset: number) {
    const index = history.index + offset;
    if (index >= 0 && index < history.paths.length) void browse(history.paths[index], { historyIndex: index, keyboard: true });
  }
  function keyboard(event: React.KeyboardEvent) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') { event.preventDefault(); focusAddress(); }
    else if (event.altKey && event.key === 'ArrowLeft') { event.preventDefault(); navigateHistory(-1); }
    else if (event.altKey && event.key === 'ArrowRight') { event.preventDefault(); navigateHistory(1); }
    else if (event.altKey && event.key === 'ArrowUp' && listing && listing.path !== listing.parent) { event.preventDefault(); void browse(listing.parent, { keyboard: true }); }
    else if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); choose(); }
  }
  function gridKeyboard(event: React.KeyboardEvent) {
    if (busy || event.ctrlKey || event.metaKey || event.altKey) return;
    let index: number | undefined;
    if (event.key === 'ArrowDown') index = Math.min(selectionIndex + 1, folders.length - 1);
    else if (event.key === 'ArrowUp') index = Math.max(0, selectionIndex - 1);
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = folders.length - 1;
    else if (event.key === 'Enter' && selection) { event.preventDefault(); void browse(selection.path, { keyboard: true }); }
    else if (event.key === ' ' && !selection && folders[0]) { event.preventDefault(); setSelection(folders[0]); }
    else if (event.key === '/') { event.preventDefault(); searchInput.current?.focus(); }
    if (index !== undefined && folders[index]) { event.preventDefault(); setSelection(folders[index]); }
  }
  function locationButton(location: Location, icon: string) {
    return <button key={`${location.kind ?? 'project'}:${location.path}`} type="button" className={listing?.path === location.path ? 'active' : ''} title={location.path} onClick={() => void browse(location.path)}><Icon name={icon} size={17} /><span>{location.name}</span></button>;
  }

  return <dialog ref={dialog} className="directory-picker" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); close(); }} onKeyDown={keyboard}>
    <header className="picker-heading"><div className="picker-heading-icon"><Icon name="folder" size={23} /></div><div><h2 id={titleId}>选择源码文件夹</h2><p>从 CorePilot 服务器选择项目目录</p></div><button type="button" className="icon-btn" aria-label="关闭文件夹选择器" onClick={close}><Icon name="close" size={19} /></button></header>
    <div className="picker-toolbar">
      <div className="picker-navigation"><button type="button" className="icon-btn" aria-label="后退" title="后退 · Alt + ←" disabled={history.index <= 0 || busy} onClick={() => navigateHistory(-1)}><Icon name="back" size={18} /></button><button type="button" className="icon-btn" aria-label="前进" title="前进 · Alt + →" disabled={history.index >= history.paths.length - 1 || busy} onClick={() => navigateHistory(1)}><Icon name="arrow" size={18} /></button><button type="button" className="icon-btn" aria-label="上一级" title="上一级 · Alt + ↑" disabled={!listing || listing.path === listing.parent || busy} onClick={() => listing && void browse(listing.parent)}><Icon name="up" size={18} /></button></div>
      <div className={`picker-address ${editingAddress ? 'editing' : ''}`}>
        {editingAddress ? <input ref={addressInput} aria-label="文件夹路径" value={address} onChange={event => setAddress(event.target.value)} placeholder="输入文件夹完整路径，按 Enter 跳转" onKeyDown={event => {
          if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void browse(address.trim(), { keyboard: true }); }
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setAddress(listing?.path ?? initial); setEditingAddress(false); }
        }} onBlur={() => { if (listing && !error && address === listing.path) setEditingAddress(false); }} /> : <nav aria-label="目录层级" className="picker-breadcrumbs">{listing?.breadcrumbs.map(crumb => <button type="button" title={crumb.path} key={crumb.path} onClick={() => void browse(crumb.path)}>{crumb.name}<Icon name="arrow" size={12} /></button>)}</nav>}
        {editingAddress ? <button type="button" className="icon-btn" aria-label="跳转到输入路径" disabled={busy || !address.trim()} onMouseDown={event => event.preventDefault()} onClick={() => void browse(address.trim(), { keyboard: true })}><Icon name="forward" size={16} /></button> : <button type="button" className="icon-btn" aria-label="输入文件夹路径" title="输入路径 · Ctrl + L" onClick={focusAddress}><Icon name="edit" size={16} /></button>}
      </div>
      <button type="button" className={`icon-btn picker-refresh ${busy ? 'loading' : ''}`} aria-label="刷新文件夹" disabled={busy || !listing} onClick={() => listing && void browse(listing.path, { refresh: true })}><Icon name="refresh" size={18} /></button>
    </div>
    <div className="picker-body">
      <aside className="picker-sidebar" aria-label="位置导航"><div className="picker-location-group"><h3>常用位置</h3>{common.map(location => locationButton(location, location.kind === 'workspace' ? 'code' : 'home'))}</div>
        {!!recent.length && <div className="picker-location-group"><h3>最近项目</h3>{recent.map(project => locationButton({ name: project.name, path: project.repository_root }, 'clock'))}</div>}
        <div className="picker-location-group"><h3>此服务器</h3>{drives.map(location => locationButton(location, 'drive'))}{!locations.length && <span className="picker-location-loading">正在读取位置…</span>}</div>
        <div className="picker-server"><Icon name="server" size={15} /><span>服务器文件系统</span></div>
      </aside>
      <section className="picker-content" aria-label="文件夹内容" aria-busy={busy}>
        <div className="picker-content-heading"><div><h3>{listing?.breadcrumbs.at(-1)?.name ?? '文件夹'}</h3><span>{busy ? '正在读取…' : `${listing?.directories.length ?? 0} 个文件夹`}</span></div><label className="picker-search"><Icon name="search" size={16} /><input ref={searchInput} aria-label="搜索当前文件夹" placeholder="搜索此位置" value={filter} onChange={event => { setFilter(event.target.value); setSelection(null); }} />{filter && <button type="button" className="icon-btn" aria-label="清除文件夹搜索" onClick={() => { setFilter(''); searchInput.current?.focus(); }}><Icon name="close" size={13} /></button>}</label></div>
        {error && <div className="picker-error" role="alert"><Icon name="report" size={18} /><div><strong>无法打开此文件夹</strong><p>{error}</p></div><button type="button" onClick={() => void browse(address, { refresh: true })}>重试</button></div>}
        <div ref={grid} role="grid" aria-label="文件夹列表" aria-multiselectable={false} aria-activedescendant={selectionIndex >= 0 ? `${rowPrefix}-${selectionIndex}` : undefined} tabIndex={0} className={`picker-grid ${busy ? 'busy' : ''}`} onKeyDown={gridKeyboard}>
          <div role="row" className="picker-columns"><span role="columnheader">名称</span><span role="columnheader">类型</span><span role="columnheader" aria-label="打开文件夹" /></div>
          {!busy && folders.map((folder, index) => <div key={folder.path} role="row" aria-label={folder.name} aria-selected={selection?.path === folder.path} id={`${rowPrefix}-${index}`} className={`picker-folder ${selection?.path === folder.path ? 'selected' : ''}`} onClick={() => { setSelection(folder); grid.current?.focus({ preventScroll: true }); }} onDoubleClick={() => void browse(folder.path, { keyboard: true })}>
            <span role="gridcell" className="picker-folder-name"><span className="picker-folder-icon"><Icon name="folder-filled" size={25} /></span><span title={folder.name}>{folder.name}</span></span><span role="gridcell" className="picker-folder-type">文件夹</span><span role="gridcell"><button type="button" className="icon-btn picker-open-folder" tabIndex={-1} aria-label={`打开文件夹 ${folder.name}`} title="进入文件夹" onClick={event => { event.stopPropagation(); void browse(folder.path, { keyboard: true }); }}><Icon name="arrow" size={16} /></button></span>
          </div>)}
          {busy && <div className="picker-skeleton" aria-label="正在读取文件夹">{Array.from({ length: 5 }, (_, index) => <div key={index}><span /><i /></div>)}</div>}
          {!busy && !error && !folders.length && <div className="picker-empty"><Icon name={filter ? 'search' : 'folder'} size={32} /><strong>{filter ? '没有匹配的文件夹' : '此文件夹为空'}</strong><p>{filter ? '试试其他名称，或清除搜索查看全部文件夹。' : '可以直接选择当前文件夹。'}</p>{filter && <button type="button" onClick={() => setFilter('')}>清除搜索</button>}</div>}
        </div>
        <div className="picker-list-hint"><span>{filter ? `${folders.length} 个匹配结果` : '单击选中，双击进入'}</span><span>↑ ↓ 选择 · Enter 进入</span></div>
      </section>
    </div>
    <footer className="picker-footer"><div className="picker-selection"><span className="picker-selection-icon"><Icon name="folder" size={20} /></span><div><span>{selection ? '已选文件夹' : '当前文件夹'}</span><strong title={chosenPath}>{chosenPath ?? '请选择一个文件夹'}</strong></div></div><div className="picker-actions"><button type="button" onClick={close}>取消</button><button type="button" className="primary" disabled={busy || !!error || !chosenPath} onClick={choose}><Icon name="check" size={16} />选择文件夹</button></div></footer>
  </dialog>;
}
