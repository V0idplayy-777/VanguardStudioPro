import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { useUI, toast } from '../../state/uiStore';
import { useProject } from '../../state/projectStore';
import { Button, Empty, IconButton, TextField, Select } from '../controls';
import { Icon } from '../icons';
import { ToolBox } from '../timeline/Timeline';
import { userPresets } from '../../app/presets';
import { importFiles, MEDIA_ACCEPT } from '../../engine/media/importer';
import { formatBytes } from '../../engine/util';
import { cmd } from '../../app/commands';
import { TEMPLATES } from '../graphics/templates';
import { MIME_TEMPLATE, useTimelineView } from '../timeline/timelineState';

/* ---------- Tools (floating tool palette, mirrors the timeline toolbox) ---------- */
export function ToolsPanel() {
  const tool = useUI((s) => s.tool);
  const setTool = useUI((s) => s.setTool);
  return (
    <div style={{ display: 'flex', height: '100%', alignItems: 'flex-start' }}>
      <ToolBox tool={tool} setTool={setTool} />
      <div style={{ padding: 8, color: 'var(--c-text-dim)', fontSize: 11, lineHeight: 1.5 }}>
        Active: <span style={{ color: 'var(--c-text-bright)' }}>{tool}</span>
        <br />
        Tools also switch with single keys (V, A, Shift+A, B, N, R, C, Y, U, P, H, Z). Hold a tool key to use it temporarily.
      </div>
    </div>
  );
}

/* ---------- Presets Library: user effect presets and graphics templates ---------- */
export function LibrariesPanel() {
  const presets = useSyncExternalStore(
    (cb) => userPresets.subscribe(cb),
    () => userPresets.get(),
  );
  const sel = useUI((s) => s.selection.clipIds);
  const [q, setQ] = useState('');
  const filtered = presets.filter((p) => !q || p.name.toLowerCase().includes(q.toLowerCase()));
  const templates = TEMPLATES.filter((t) => !q || t.name.toLowerCase().includes(q.toLowerCase()));
  const exportAll = () => {
    const blob = new Blob([JSON.stringify(presets, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'vanguard-presets.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  const importPresets = () => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.json';
    inp.onchange = async () => {
      const f = inp.files?.[0];
      if (!f) return;
      try {
        const arr = JSON.parse(await f.text());
        if (!Array.isArray(arr)) throw new Error('Not a preset list');
        let n = 0;
        for (const p of arr) if (p && p.name && Array.isArray(p.effects)) { userPresets.add({ ...p, id: `p${Date.now().toString(36)}${n++}` }); }
        toast('success', 'Presets imported', `${n} preset${n === 1 ? '' : 's'} added.`);
      } catch (e) {
        toast('error', 'Import failed', String(e));
      }
    };
    inp.click();
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="toolbar">
        <TextField value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search library" icon="search" style={{ flex: 1 }} />
        <IconButton icon="import" label="Import presets (.json)" sm onClick={importPresets} />
        <IconButton icon="export" label="Export all presets (.json)" sm onClick={exportAll} disabled={!presets.length} />
      </div>
      <div className="scroll-y" style={{ flex: 1 }}>
        <div className="section-title" style={{ padding: '8px 8px 2px', color: 'var(--c-text-dim)', fontSize: 11 }}>Effect presets ({filtered.length})</div>
        {filtered.length === 0 ? <div style={{ padding: '4px 8px 8px', color: 'var(--c-text-faint)', fontSize: 11 }}>Save a preset from the Effects panel (select a clip with effects, then the preset button).</div> : null}
        {filtered.map((p) => (
          <div key={p.id} className="list-row" onDoubleClick={() => (sel.length ? cmd.applyPreset(sel, p) : toast('info', 'Select a clip first'))} title="Double-click to apply to selected clips" onContextMenu={(e) => { e.preventDefault(); useUI.getState().openContextMenu(e.clientX, e.clientY, [{ label: 'Apply to selection', disabled: !sel.length, onSelect: () => cmd.applyPreset(sel, p) }, { label: 'Delete', danger: true, onSelect: () => userPresets.remove(p.id) }]); }}>
            <Icon name="presets" size={12} style={{ color: 'var(--c-text-dim)' }} />
            <span className="grow">{p.name}</span>
            <span className="dim" style={{ fontSize: 11 }}>{p.effectType}</span>
          </div>
        ))}
        <div className="section-title" style={{ padding: '10px 8px 2px', color: 'var(--c-text-dim)', fontSize: 11 }}>Motion graphics templates ({templates.length})</div>
        {templates.map((t) => (
          <div key={t.id} className="list-row" draggable onDragStart={(e) => { e.dataTransfer.setData(MIME_TEMPLATE, t.id); useTimelineView.getState().setExternalDrag({ kind: 'template', id: t.id }); }} onDragEnd={() => useTimelineView.getState().setExternalDrag(null)} title={`${t.description} (drag to the timeline)`}>
            <Icon name="clipTitle" size={12} style={{ color: 'var(--c-text-dim)' }} />
            <span className="grow">{t.name}</span>
            <span className="dim" style={{ fontSize: 11 }}>{t.category}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- Media Browser: browse a local folder with the File System Access API ---------- */
type Entry = { name: string; kind: 'file' | 'directory'; handle: any; size?: number; type?: string };

export function MediaBrowserPanel() {
  const [root, setRoot] = useState<any>(null);
  const [path, setPath] = useState<any[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<'all' | 'video' | 'audio' | 'image'>('all');
  const supported = typeof (window as any).showDirectoryPicker === 'function';
  const currentBin = useUI((s) => s.currentBinId);

  const list = async (dir: any) => {
    setBusy(true);
    const out: Entry[] = [];
    try {
      for await (const [name, handle] of dir.entries()) {
        if (name.startsWith('.')) continue;
        if (handle.kind === 'file') {
          const f = await handle.getFile();
          out.push({ name, kind: 'file', handle, size: f.size, type: f.type });
        } else out.push({ name, kind: 'directory', handle });
      }
    } catch (e) {
      toast('error', 'Cannot read folder', String(e));
    }
    out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1));
    setEntries(out);
    setBusy(false);
  };
  const open = async () => {
    try {
      const dir = await (window as any).showDirectoryPicker({ mode: 'read' });
      setRoot(dir);
      setPath([dir]);
      await list(dir);
    } catch {
      /* cancelled */
    }
  };
  const enter = async (e: Entry) => {
    if (e.kind === 'directory') {
      setPath((p) => [...p, e.handle]);
      await list(e.handle);
    } else {
      const f: File = await e.handle.getFile();
      await importFiles([f], { binId: currentBin });
      toast('success', 'Imported', f.name);
    }
  };
  const up = async (i: number) => {
    const p = path.slice(0, i + 1);
    setPath(p);
    await list(p[p.length - 1]);
  };
  const media = (e: Entry) => {
    const t = e.type ?? '';
    if (t.startsWith('video/') || /\.(mkv|mov|mp4|webm)$/i.test(e.name)) return 'video';
    if (t.startsWith('audio/') || /\.(mp3|wav|flac|aac|m4a|ogg)$/i.test(e.name)) return 'audio';
    if (t.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg)$/i.test(e.name)) return 'image';
    return null;
  };
  const visible = entries.filter((e) => e.kind === 'directory' || (media(e) && (filter === 'all' || media(e) === filter)));
  const importAll = async () => {
    const files: File[] = [];
    for (const e of visible) if (e.kind === 'file') files.push(await e.handle.getFile());
    if (!files.length) return;
    await importFiles(files, { binId: currentBin });
    toast('success', 'Imported', `${files.length} file${files.length === 1 ? '' : 's'}`);
  };
  useEffect(() => {
    void root;
  }, [root]);
  if (!supported) {
    return (
      <Empty title="Media Browser" icon="folder">
        Folder browsing needs the File System Access API (Chrome, Edge). Use Import (Ctrl+I) or drag files into the Project panel instead.
        <div style={{ marginTop: 8 }}>
          <Button sm onClick={() => void cmd.importMedia(currentBin)}>Import...</Button>
        </div>
      </Empty>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="toolbar">
        <Button sm icon="folder" onClick={open}>{root ? 'Change folder' : 'Open folder'}</Button>
        <Select value={filter} options={[{ value: 'all', label: 'All media' }, { value: 'video', label: 'Video' }, { value: 'audio', label: 'Audio' }, { value: 'image', label: 'Images' }]} onChange={(v) => setFilter(v as any)} />
        <span className="spacer" />
        <Button sm onClick={importAll} disabled={!visible.some((e) => e.kind === 'file')}>Import all shown</Button>
      </div>
      {path.length ? (
        <div className="bin-path" style={{ display: 'flex', gap: 2, height: 22, alignItems: 'center', padding: '0 6px', fontSize: 11, borderBottom: '1px solid var(--c-line-faint)' }}>
          {path.map((h, i) => (
            <React.Fragment key={i}>
              {i ? <Icon name="chevronRight" size={10} /> : null}
              <button type="button" onClick={() => up(i)} style={{ color: i === path.length - 1 ? 'var(--c-text)' : 'var(--c-text-dim)' }}>{h.name}</button>
            </React.Fragment>
          ))}
        </div>
      ) : null}
      <div className="scroll-y" style={{ flex: 1 }}>
        {!root ? <div className="empty" style={{ marginTop: 30 }}><strong>No folder open</strong>Open a folder to browse it. Double-click a file to import it into the current bin. Accepted: {MEDIA_ACCEPT.split(',').filter((x) => x.startsWith('.')).join(' ')}</div> : null}
        {busy ? <div style={{ padding: 8, color: 'var(--c-text-dim)' }}>Reading...</div> : null}
        {visible.map((e) => (
          <div key={e.name} className="list-row" onDoubleClick={() => void enter(e)} title={e.kind === 'file' ? 'Double-click to import' : 'Double-click to open'} draggable={e.kind === 'file'} onDragStart={async (ev) => { ev.preventDefault(); }}>
            <Icon name={e.kind === 'directory' ? 'folder' : media(e) === 'video' ? 'clipVideo' : media(e) === 'audio' ? 'clipAudio' : 'clipImage'} size={12} style={{ color: 'var(--c-text-dim)' }} />
            <span className="grow">{e.name}</span>
            <span className="dim" style={{ fontSize: 11 }}>{e.size != null ? formatBytes(e.size) : ''}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export { useProject };
