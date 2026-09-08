import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useProject, findAsset, sequenceDuration } from '../../state/projectStore';
import { useUI, toast, type ContextMenuItem } from '../../state/uiStore';
import { cmd, projectSelection } from '../../app/commands';
import { IconButton, TextField, MenuButton, Slider } from '../controls';
import { Icon, Swatch, type IconName } from '../icons';
import { LABEL_COLORS, type LabelColor, type MediaAsset, type Bin } from '../../types/project';
import { framesToTimecode } from '../../engine/timecode';
import { assetPoster } from '../timeline/thumbnails';
import { getMedia, onMediaChange } from '../../engine/media/mediaStore';
import { MIME_ASSETS, useTimelineView } from '../timeline/timelineState';
import { importFiles } from '../../engine/media/importer';
import { usePlayback } from '../../engine/playback/playback';
import { formatBytes } from '../../engine/util';

type Row = { kind: 'bin'; bin: Bin } | { kind: 'asset'; asset: MediaAsset };

function useProjectSelection() {
  return useSyncExternalStore(
    (cb) => projectSelection.subscribe(cb),
    () => projectSelection.get(),
  );
}

export function ProjectPanel() {
  const project = useProject((s) => s.project);
  const ui = useUI();
  const sel = useProjectSelection();
  const [dragOver, setDragOver] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [, force] = useState(0);
  useEffect(() => onMediaChange(() => force((n) => n + 1)), []);

  const currentBin = ui.currentBinId;
  const search = ui.projectSearch.trim().toLowerCase();

  const rows = useMemo<Row[]>(() => {
    const bins = project.bins.filter((b) => (search ? b.name.toLowerCase().includes(search) : b.parentId === currentBin));
    const assets = project.assets.filter((a) => (search ? a.name.toLowerCase().includes(search) || (a.meta.tags ?? []).some((t) => t.toLowerCase().includes(search)) || (a.meta.comment ?? '').toLowerCase().includes(search) : a.binId === currentBin));
    const { key, dir } = ui.projectSort;
    const val = (a: MediaAsset): string | number => {
      switch (key) {
        case 'name':
          return a.name.toLowerCase();
        case 'kind':
          return a.kind;
        case 'duration':
          return a.duration ?? 0;
        case 'createdAt':
          return a.createdAt;
        case 'label':
          return a.label;
        case 'size':
          return a.file?.size ?? 0;
      }
    };
    assets.sort((a, b) => {
      const va = val(a),
        vb = val(b);
      return (va < vb ? -1 : va > vb ? 1 : 0) * dir;
    });
    bins.sort((a, b) => a.name.localeCompare(b.name) * (key === 'name' ? dir : 1));
    return [...bins.map((bin) => ({ kind: 'bin', bin }) as Row), ...assets.map((asset) => ({ kind: 'asset', asset }) as Row)];
  }, [project.bins, project.assets, currentBin, search, ui.projectSort]);

  const binPath = useMemo(() => {
    const path: Bin[] = [];
    let b = project.bins.find((x) => x.id === currentBin);
    while (b) {
      path.unshift(b);
      b = project.bins.find((x) => x.id === b!.parentId);
    }
    return path;
  }, [project.bins, currentBin]);

  const idOf = (r: Row) => (r.kind === 'bin' ? r.bin.id : r.asset.id);
  const lastAnchor = useRef<string | null>(null);

  const select = (id: string, e: React.MouseEvent | React.KeyboardEvent) => {
    if ((e as React.MouseEvent).shiftKey && lastAnchor.current) {
      const ids = rows.map(idOf);
      const a = ids.indexOf(lastAnchor.current),
        b = ids.indexOf(id);
      if (a >= 0 && b >= 0) {
        projectSelection.set(ids.slice(Math.min(a, b), Math.max(a, b) + 1));
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) projectSelection.set(sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]);
    else projectSelection.set([id]);
    lastAnchor.current = id;
  };

  const open = (r: Row) => {
    if (r.kind === 'bin') {
      ui.setCurrentBinId(r.bin.id);
      projectSelection.set([]);
    } else if (r.asset.kind === 'sequence' && r.asset.sequenceId) cmd.openSequence(r.asset.sequenceId);
    else {
      ui.setSourceAssetId(r.asset.id);
      ui.setFocusedPanel('source');
    }
  };

  const onDragStart = (e: React.DragEvent, id: string) => {
    const ids = sel.includes(id) ? sel : [id];
    projectSelection.set(ids);
    const assetIds = ids.filter((x) => project.assets.some((a) => a.id === x));
    // include assets inside dragged bins
    for (const bid of ids.filter((x) => project.bins.some((b) => b.id === x))) for (const a of project.assets) if (a.binId === bid) assetIds.push(a.id);
    e.dataTransfer.setData(MIME_ASSETS, JSON.stringify(assetIds));
    e.dataTransfer.setData('text/plain', ids.map((x) => findAsset(project, x)?.name ?? x).join(', '));
    e.dataTransfer.effectAllowed = 'copyMove';
    useTimelineView.getState().setExternalDrag({ kind: 'asset', ids: assetIds });
  };
  const onDragEnd = () => useTimelineView.getState().setExternalDrag(null);

  const dropOnBin = (e: React.DragEvent, binId: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    if (e.dataTransfer.types.includes('Files')) {
      void importFiles(Array.from(e.dataTransfer.files), { binId });
      return;
    }
    const raw = e.dataTransfer.getData(MIME_ASSETS);
    if (!raw) return;
    const ids = Array.from(new Set([...sel, ...(JSON.parse(raw) as string[])]));
    if (binId && ids.includes(binId)) return;
    cmd.moveAssetsToBin(ids, binId);
  };

  const ctx = (e: React.MouseEvent, r?: Row) => {
    e.preventDefault();
    e.stopPropagation();
    if (r && !sel.includes(idOf(r))) projectSelection.set([idOf(r)]);
    const ids = r ? (sel.includes(idOf(r)) ? sel : [idOf(r)]) : [];
    const assets = ids.map((id) => findAsset(project, id)).filter(Boolean) as MediaAsset[];
    const single = assets.length === 1 ? assets[0] : null;
    const items: ContextMenuItem[] = [];
    if (r) {
      if (single && single.kind !== 'sequence') items.push({ label: 'Open in Source Monitor', onSelect: () => open(r) });
      if (single?.kind === 'sequence') items.push({ label: 'Open Sequence', onSelect: () => open(r) });
      if (r.kind === 'bin') items.push({ label: 'Open Bin', onSelect: () => open(r) });
      if (assets.length && assets.some((a) => a.kind !== 'sequence')) {
        items.push({ label: 'Insert at Playhead', shortcut: ',', onSelect: () => cmd.addClipsToSequenceAtPlayhead(assets, 'insert') });
        items.push({ label: 'Overwrite at Playhead', shortcut: '.', onSelect: () => cmd.addClipsToSequenceAtPlayhead(assets, 'overwrite') });
        const proxyable = assets.filter((a) => a.hasVideo && a.kind !== 'sequence' && a.kind !== 'generator' && a.proxy?.status !== 'ready');
        if (proxyable.length) items.push({ label: `Create Prox${proxyable.length === 1 ? 'y' : 'ies'} (${proxyable.length})`, onSelect: () => void import('../../engine/media/proxy').then((m) => m.createProxiesForAssets(proxyable.map((a) => a.id))) });
      }
      if (single && single.kind !== 'sequence') items.push({ label: 'New Sequence From Clip', onSelect: () => cmd.newSequenceFromClip(single) });
      if (single?.kind === 'sequence' && single.sequenceId) items.push({ label: 'Sequence Settings...', onSelect: () => { cmd.openSequence(single.sequenceId!); ui.openModal({ kind: 'sequenceSettings' }); } });
      items.push({ separator: true });
      items.push({ label: 'Rename', shortcut: 'F2', onSelect: () => setRenaming(idOf(r)) });
      items.push({ label: 'Label', submenu: (Object.keys(LABEL_COLORS) as LabelColor[]).map((l) => ({ label: l[0].toUpperCase() + l.slice(1), checked: single?.label === l, onSelect: () => useProject.getState().update('Label', (p) => { for (const id of ids) { const a = p.assets.find((x) => x.id === id); if (a) a.label = l; const b = p.bins.find((x) => x.id === id); if (b) b.label = l; } }) })) });
      if (single) {
        items.push({ label: single.meta.good ? 'Unmark Good Take' : 'Mark Good Take', onSelect: () => useProject.getState().update('Good take', (p) => { const a = p.assets.find((x) => x.id === single.id); if (a) a.meta.good = !a.meta.good; }) });
        if (single.kind === 'video' || single.kind === 'image') items.push({ label: 'Interpret Footage...', onSelect: () => ui.openModal({ kind: 'interpretFootage', payload: { assetId: single.id } }) });
        if (single.offline) items.push({ label: 'Link Media...', onSelect: () => ui.openModal({ kind: 'linkMedia', payload: { assetIds: [single.id] } }) });
        if (single.kind === 'video') items.push({ label: 'Scene Edit Detection...', onSelect: () => ui.openModal({ kind: 'sceneDetect', payload: { assetId: single.id } }) });
        if (single.hasVideo && single.kind !== 'sequence') {
          if (single.proxy?.status === 'ready') items.push({ label: 'Delete Proxy', onSelect: () => void import('../../engine/media/proxy').then((m) => m.detachProxy(single.id, true)) });
          else if (single.proxy?.status !== 'pending') items.push({ label: 'Create Proxy', onSelect: () => void import('../../engine/media/proxy').then((m) => m.createProxyForAsset(single.id)) });
        }
        if (single.hasAudio) items.push({ label: 'Clean Up Voice...', onSelect: () => ui.openModal({ kind: 'voiceCleanup', payload: { assetId: single.id } }) });
        items.push({ label: 'Properties', onSelect: () => { ui.setFocusedPanel('info'); } });
      }
      items.push({ separator: true });
      items.push({ label: 'Move to Bin', submenu: [{ label: '(Project root)', onSelect: () => cmd.moveAssetsToBin(ids, null) }, ...project.bins.filter((b) => !ids.includes(b.id)).map((b) => ({ label: b.name, onSelect: () => cmd.moveAssetsToBin(ids, b.id) }))] });
      items.push({ label: 'Delete', shortcut: 'Delete', danger: true, onSelect: () => cmd.deleteAssets(ids) });
      items.push({ separator: true });
    }
    items.push({ label: 'Import...', shortcut: 'Ctrl+I', onSelect: () => void cmd.importMedia(currentBin) });
    items.push({ label: 'New Bin', shortcut: 'Ctrl+B', onSelect: () => cmd.newBin() });
    items.push({ label: 'New Sequence...', shortcut: 'Ctrl+N', onSelect: () => cmd.newSequence() });
    items.push({
      label: 'New Item',
      submenu: [
        { label: 'Adjustment Layer', onSelect: () => cmd.newGenerator('adjustmentLayer') },
        { label: 'Color Matte...', onSelect: () => ui.openModal({ kind: 'colorMatte' }) },
        { label: 'Black Video', onSelect: () => cmd.newGenerator('blackVideo') },
        { label: 'Bars and Tone', onSelect: () => cmd.newGenerator('barsAndTone') },
        { label: 'Universal Counting Leader...', onSelect: () => ui.openModal({ kind: 'generateCountdown' }) },
        { label: 'Title (Graphic)', onSelect: () => cmd.newGenerator('graphic', {}, 'Title') },
      ],
    });
    items.push({ separator: true });
    items.push({ label: 'Remove Unused', onSelect: () => cmd.removeUnused() });
    items.push({ label: 'Reveal offline clips', disabled: !project.assets.some((a) => a.offline), onSelect: () => projectSelection.set(project.assets.filter((a) => a.offline).map((a) => a.id)) });
    ui.openContextMenu(e.clientX, e.clientY, items);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (sel.length) {
        e.preventDefault();
        cmd.deleteAssets(sel);
      }
    } else if (e.key === 'F2' && sel.length === 1) setRenaming(sel[0]);
    else if (e.key === 'Enter' && sel.length === 1) {
      const r = rows.find((x) => idOf(x) === sel[0]);
      if (r) open(r);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const ids = rows.map(idOf);
      const i = ids.indexOf(sel[sel.length - 1]);
      const n = e.key === 'ArrowDown' ? Math.min(ids.length - 1, i + 1) : Math.max(0, i - 1);
      if (ids[n]) select(ids[n], e);
    } else if (e.key === 'Backspace' && e.altKey) ui.setCurrentBinId(binPath[binPath.length - 2]?.id ?? null);
    else if ((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      projectSelection.set(rows.map(idOf));
    }
  };

  const commitRename = (id: string, name: string) => {
    setRenaming(null);
    if (!name.trim()) return;
    if (project.bins.some((b) => b.id === id)) useProject.getState().update('Rename bin', (p) => { const b = p.bins.find((x) => x.id === id); if (b) b.name = name.trim(); });
    else cmd.renameAsset(id, name.trim());
  };

  const sortBtn = (key: typeof ui.projectSort.key, label: string, style?: React.CSSProperties) => (
    <button type="button" style={style} onClick={() => ui.setProjectSort(key)} title={`Sort by ${label}`}>
      {label}
      {ui.projectSort.key === key ? <Icon name={ui.projectSort.dir === 1 ? 'chevronDown' : 'chevronUp'} size={10} /> : null}
    </button>
  );

  const counts = `${project.assets.length} item${project.assets.length === 1 ? '' : 's'}${sel.length ? `, ${sel.length} selected` : ''}`;

  return (
    <div
      className={`project-panel ${dragOver ? 'dragover' : ''}`}
      style={{ display: 'flex', flexDirection: 'column', height: '100%', position: 'relative', outline: 'none' }}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes(MIME_ASSETS)) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
      }}
      onDrop={(e) => dropOnBin(e, currentBin)}
      onContextMenu={(e) => ctx(e)}
    >
      <div className="toolbar">
        <TextField value={ui.projectSearch} onChange={(e) => ui.setProjectSearch(e.target.value)} placeholder="Search names, tags, comments" style={{ flex: 1, minWidth: 60 }} icon="search" />
        <div className="seg" role="group" aria-label="View">
          <button type="button" className={ui.projectView === 'list' ? 'on' : ''} title="List view" onClick={() => ui.setProjectView('list')}><Icon name="list" size={12} /></button>
          <button type="button" className={ui.projectView === 'icon' ? 'on' : ''} title="Icon view" onClick={() => ui.setProjectView('icon')}><Icon name="grid" size={12} /></button>
        </div>
        {ui.projectView === 'icon' ? <Slider value={ui.projectIconSize} min={64} max={220} step={1} onChange={(v) => ui.setProjectIconSize(v)} style={{ width: 64 }} title="Icon size" /> : null}
        <IconButton icon="binAdd" label="New Bin (Ctrl+B)" sm onClick={() => cmd.newBin()} />
        <MenuButton icon="add" label="New item" className="ibtn sm" items={[
          { label: 'Sequence...', onSelect: () => cmd.newSequence() },
          { label: 'Adjustment Layer', onSelect: () => cmd.newGenerator('adjustmentLayer') },
          { label: 'Color Matte...', onSelect: () => ui.openModal({ kind: 'colorMatte' }) },
          { label: 'Black Video', onSelect: () => cmd.newGenerator('blackVideo') },
          { label: 'Bars and Tone', onSelect: () => cmd.newGenerator('barsAndTone') },
          { label: 'Universal Counting Leader...', onSelect: () => ui.openModal({ kind: 'generateCountdown' }) },
          { label: 'Title (Graphic)', onSelect: () => cmd.newGenerator('graphic', {}, 'Title') },
        ]} />
        <IconButton icon="import" label="Import media (Ctrl+I)" sm onClick={() => void cmd.importMedia(currentBin)} />
      </div>
      <div className="bin-path">
        <button type="button" onClick={() => ui.setCurrentBinId(null)} onDragOver={(e) => e.preventDefault()} onDrop={(e) => dropOnBin(e, null)} title="Project root">{project.settings.name || 'Project'}</button>
        {binPath.map((b, i) => (
          <React.Fragment key={b.id}>
            <Icon name="chevronRight" size={10} />
            <button type="button" className={i === binPath.length - 1 ? 'cur' : ''} onClick={() => ui.setCurrentBinId(b.id)} onDragOver={(e) => e.preventDefault()} onDrop={(e) => dropOnBin(e, b.id)}>{b.name}</button>
          </React.Fragment>
        ))}
        <span style={{ marginLeft: 'auto', color: 'var(--c-text-faint)' }}>{counts}</span>
      </div>
      <div ref={listRef} className="scroll-y" style={{ flex: 1 }} onClick={(e) => { if (e.target === e.currentTarget) projectSelection.set([]); }}>
        {rows.length === 0 ? (
          <div className="empty" style={{ marginTop: 40 }}>
            <strong>{search ? 'No matches' : currentBin ? 'Empty bin' : 'No media yet'}</strong>
            {search ? 'Try a different search term.' : 'Import files (Ctrl+I) or drop them anywhere on this panel. Video, audio and images are all fine.'}
            {!search ? (
              <div style={{ marginTop: 10 }}>
                <button type="button" className="btn" onClick={() => void cmd.importMedia(currentBin)}>Import...</button>
              </div>
            ) : null}
          </div>
        ) : ui.projectView === 'list' ? (
          <>
            <div className="list-head">
              <span style={{ width: 36 }} />
              {sortBtn('name', 'Name', { flex: 1, textAlign: 'left' })}
              {sortBtn('label', '', { width: 8 })}
              {sortBtn('kind', 'Type', { width: 64 })}
              {sortBtn('duration', 'Duration', { width: 84, justifyContent: 'flex-end' })}
              <span style={{ width: 90 }}>Frame / Rate</span>
              {sortBtn('size', 'Size', { width: 60, justifyContent: 'flex-end' })}
            </div>
            {rows.map((r) => (
              <ListRow key={idOf(r)} row={r} selected={sel.includes(idOf(r))} renaming={renaming === idOf(r)} onRename={(n) => commitRename(idOf(r), n)} onSelect={(e) => select(idOf(r), e)} onOpen={() => open(r)} onDragStart={(e) => onDragStart(e, idOf(r))} onDragEnd={onDragEnd} onDropBin={r.kind === 'bin' ? (e) => dropOnBin(e, r.bin.id) : undefined} onContext={(e) => ctx(e, r)} project={project} />
            ))}
          </>
        ) : (
          <div className="asset-grid" style={{ ['--icon-size' as any]: `${ui.projectIconSize}px` }}>
            {rows.map((r) => (
              <IconCard key={idOf(r)} row={r} selected={sel.includes(idOf(r))} renaming={renaming === idOf(r)} onRename={(n) => commitRename(idOf(r), n)} onSelect={(e) => select(idOf(r), e)} onOpen={() => open(r)} onDragStart={(e) => onDragStart(e, idOf(r))} onDragEnd={onDragEnd} onDropBin={r.kind === 'bin' ? (e) => dropOnBin(e, r.bin.id) : undefined} onContext={(e) => ctx(e, r)} project={project} />
            ))}
          </div>
        )}
      </div>
      {dragOver ? <div className="drop-overlay">Drop to import into {binPath.length ? binPath[binPath.length - 1].name : 'the project'}</div> : null}
    </div>
  );
}

interface RowProps {
  row: Row;
  selected: boolean;
  renaming: boolean;
  onRename: (n: string) => void;
  onSelect: (e: React.MouseEvent) => void;
  onOpen: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onDropBin?: (e: React.DragEvent) => void;
  onContext: (e: React.MouseEvent) => void;
  project: ReturnType<typeof useProject.getState>['project'];
}

function assetIcon(a: MediaAsset): IconName {
  if (a.offline) return 'offline';
  switch (a.kind) {
    case 'video':
      return a.hasAudio ? 'clipVideo' : 'clipVideo';
    case 'audio':
      return 'clipAudio';
    case 'image':
      return 'clipImage';
    case 'sequence':
      return 'sequence';
    case 'generator':
      return a.generator === 'adjustmentLayer' ? 'clipAdjust' : a.generator === 'graphic' ? 'clipTitle' : 'clipMatte';
  }
}

function kindLabel(a: MediaAsset) {
  if (a.kind === 'generator') return { adjustmentLayer: 'Adjustment', colorMatte: 'Matte', blackVideo: 'Black', barsAndTone: 'Bars', graphic: 'Graphic', countdown: 'Leader' }[a.generator ?? 'colorMatte'];
  if (a.kind === 'video') return a.hasAudio ? 'Video+Audio' : 'Video';
  return a.kind[0].toUpperCase() + a.kind.slice(1);
}

function durationOf(a: MediaAsset, project: RowProps['project']) {
  if (a.kind === 'sequence') {
    const s = project.sequences.find((x) => x.id === a.sequenceId);
    return s ? framesToTimecode(sequenceDuration(s), s.settings.fps, s.settings.dropFrame) : '';
  }
  if (a.duration == null) return a.kind === 'image' ? 'Still' : '';
  const fps = a.fps && a.fps > 0 ? a.fps : 30;
  return framesToTimecode(Math.round(a.duration * fps), fps);
}

function frameInfo(a: MediaAsset) {
  const parts: string[] = [];
  if (a.width && a.height) parts.push(`${a.width}x${a.height}`);
  if (a.fps) parts.push(`${+a.fps.toFixed(2)}`);
  if (a.kind === 'audio' && a.sampleRate) parts.push(`${(a.sampleRate / 1000).toFixed(1)}k`);
  return parts.join(' ');
}

function ListRow({ row, selected, renaming, onRename, onSelect, onOpen, onDragStart, onDragEnd, onDropBin, onContext, project }: RowProps) {
  const [name, setName] = useState(row.kind === 'bin' ? row.bin.name : row.asset.name);
  const [hoverBin, setHoverBin] = useState(false);
  useEffect(() => setName(row.kind === 'bin' ? row.bin.name : row.asset.name), [row]);
  const label = row.kind === 'bin' ? row.bin.label : row.asset.label;
  return (
    <div
      className={`list-row ${selected ? 'selected' : ''} ${hoverBin ? 'drop' : ''}`}
      draggable={!renaming}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDropBin ? (e) => { e.preventDefault(); e.stopPropagation(); setHoverBin(true); } : undefined}
      onDragLeave={onDropBin ? () => setHoverBin(false) : undefined}
      onDrop={onDropBin ? (e) => { setHoverBin(false); onDropBin(e); } : undefined}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onContextMenu={onContext}
      style={hoverBin ? { outline: '1px solid var(--c-accent)', outlineOffset: -1 } : undefined}
      data-asset-id={row.kind === 'asset' ? row.asset.id : undefined}
    >
      <span className="label-bar" style={{ background: LABEL_COLORS[label] }} />
      {row.kind === 'bin' ? (
        <span className="asset-thumb" style={{ background: 'transparent', border: 0 }}><Icon name="bin" size={14} /></span>
      ) : (
        <Thumb asset={row.asset} w={36} h={20} />
      )}
      {renaming ? (
        <input className="field" autoFocus value={name} style={{ flex: 1, height: 18 }} onChange={(e) => setName(e.target.value)} onBlur={() => onRename(name)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') onRename(name); if (e.key === 'Escape') onRename(''); }} onClick={(e) => e.stopPropagation()} />
      ) : (
        <span className="grow" title={row.kind === 'asset' ? row.asset.file?.name ?? row.asset.name : row.bin.name}>
          {row.kind === 'asset' && row.asset.offline ? <span style={{ color: 'var(--c-danger)', marginRight: 4 }}>Offline</span> : null}
          {row.kind === 'asset' && row.asset.meta.good ? <Icon name="check" size={10} style={{ marginRight: 3, color: 'var(--c-ok)' }} /> : null}
          {row.kind === 'bin' ? row.bin.name : row.asset.name}
          {row.kind === 'asset' && row.asset.proxy ? (
            <span className="pill proxy-pill" title={row.asset.proxy.status === 'ready' ? `Proxy ready — ${row.asset.proxy.width}×${row.asset.proxy.height}` : 'Proxy building…'}>{row.asset.proxy.status === 'ready' ? 'PX' : 'PX…'}</span>
          ) : null}
          {row.kind === 'asset' && row.asset.cleanedAudio ? (
            <span className="pill cleaned-pill" title={`Cleaned voice — ${row.asset.cleanedAudio.preset}`}>VC</span>
          ) : null}
        </span>
      )}
      <span style={{ width: 8 }} />
      <span className="dim" style={{ width: 64 }}>{row.kind === 'bin' ? 'Bin' : kindLabel(row.asset)}</span>
      <span className="dim tc" style={{ width: 84, textAlign: 'right' }}>{row.kind === 'bin' ? `${project.assets.filter((a) => a.binId === row.bin.id).length} items` : durationOf(row.asset, project)}</span>
      <span className="dim" style={{ width: 90, fontSize: 11 }}>{row.kind === 'asset' ? frameInfo(row.asset) : ''}</span>
      <span className="dim" style={{ width: 60, textAlign: 'right', fontSize: 11 }}>{row.kind === 'asset' && row.asset.file ? formatBytes(row.asset.file.size) : ''}</span>
    </div>
  );
}

function IconCard({ row, selected, renaming, onRename, onSelect, onOpen, onDragStart, onDragEnd, onDropBin, onContext, project }: RowProps) {
  const [name, setName] = useState(row.kind === 'bin' ? row.bin.name : row.asset.name);
  const [scrub, setScrub] = useState<number | null>(null);
  useEffect(() => setName(row.kind === 'bin' ? row.bin.name : row.asset.name), [row]);
  const label = row.kind === 'bin' ? row.bin.label : row.asset.label;
  const asset = row.kind === 'asset' ? row.asset : null;
  const scrubbable = asset && (asset.kind === 'video' || asset.kind === 'audio');
  return (
    <div
      className={`asset-card ${selected ? 'selected' : ''}`}
      draggable={!renaming}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDropBin ? (e) => { e.preventDefault(); e.stopPropagation(); } : undefined}
      onDrop={onDropBin}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onContextMenu={onContext}
      data-asset-id={asset?.id}
    >
      <div
        className="thumb"
        style={{ cursor: scrubbable ? 'ew-resize' : 'default' }}
        onPointerMove={scrubbable ? (e) => { const r = e.currentTarget.getBoundingClientRect(); setScrub((e.clientX - r.left) / r.width); } : undefined}
        onPointerLeave={() => setScrub(null)}
        title={scrubbable ? 'Hover to scrub' : undefined}
      >
        {row.kind === 'bin' ? (
          <Icon name="bin" size={28} />
        ) : (
          <>
            <Thumb asset={row.asset} w={Math.round(useUI.getState().projectIconSize * 1.5)} h={Math.round(useUI.getState().projectIconSize * 0.85)} time={scrub != null && row.asset.duration ? scrub * row.asset.duration : undefined} contain />
            <span className="dur">{durationOf(row.asset, project)}</span>
            {row.asset.proxy ? <span className="pill proxy-pill badge-tl" title={row.asset.proxy.status === 'ready' ? `Proxy ready — ${row.asset.proxy.width}×${row.asset.proxy.height}` : 'Proxy building…'}>{row.asset.proxy.status === 'ready' ? 'PX' : 'PX…'}</span> : null}
            {row.asset.cleanedAudio ? <span className="pill cleaned-pill badge-tl2" title={`Cleaned voice — ${row.asset.cleanedAudio.preset}`}>VC</span> : null}
            {scrub != null ? <span className="hover-scrub" style={{ width: `${scrub * 100}%` }} /> : null}
          </>
        )}
      </div>
      {renaming ? (
        <input className="field" autoFocus value={name} style={{ height: 18 }} onChange={(e) => setName(e.target.value)} onBlur={() => onRename(name)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') onRename(name); if (e.key === 'Escape') onRename(''); }} onClick={(e) => e.stopPropagation()} />
      ) : (
        <div className="name" title={name}>
          <span className="lbl" style={{ background: LABEL_COLORS[label] }} />
          <Icon name={asset ? assetIcon(asset) : 'bin'} size={11} style={{ color: 'var(--c-text-dim)', flex: 'none' }} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</span>
        </div>
      )}
    </div>
  );
}

/** Small poster frame for an asset; re-renders when media decodes. */
export function Thumb({ asset, w, h, time, contain }: { asset: MediaAsset; w: number; h: number; time?: number; contain?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => onMediaChange(() => setTick((t) => t + 1)), []);
  const version = useProject((s) => (asset.kind === 'sequence' ? s.project.revision : 0));
  const draw = useCallback(async () => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    const ctx = cv.getContext('2d')!;
    ctx.fillStyle = '#0d0d0d';
    ctx.fillRect(0, 0, cv.width, cv.height);
    const img = await assetPoster(asset, cv.width, cv.height, time);
    if (!img || ref.current !== cv) return;
    if (contain) {
      const s = Math.min(cv.width / img.width, cv.height / img.height);
      const dw = img.width * s,
        dh = img.height * s;
      ctx.drawImage(img, (cv.width - dw) / 2, (cv.height - dh) / 2, dw, dh);
    } else ctx.drawImage(img, 0, 0, cv.width, cv.height);
  }, [asset, w, h, time, contain]);
  useEffect(() => {
    void draw();
  }, [draw, tick, version]);
  const rec = getMedia(asset.id);
  const icon: IconName | null = asset.kind === 'audio' ? 'clipAudio' : asset.offline ? 'offline' : null;
  return (
    <span className="asset-thumb" style={{ width: w, height: h, position: 'relative' }}>
      <canvas ref={ref} style={{ width: w, height: h }} />
      {icon && !rec?.peaks && asset.kind === 'audio' ? <Icon name={icon} size={Math.min(14, h - 4)} style={{ position: 'absolute' }} /> : null}
    </span>
  );
}

export { toast, usePlayback };
