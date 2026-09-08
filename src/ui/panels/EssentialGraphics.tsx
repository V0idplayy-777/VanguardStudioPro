import React, { useEffect, useRef, useState } from 'react';
import { useProject, useActiveSequence, findAsset } from '../../state/projectStore';
import { useUI, toast } from '../../state/uiStore';
import { usePlayback } from '../../engine/playback/playback';
import { HotText, Select, Checkbox, Button, IconButton, ColorChip, TextField, Empty, Slider } from '../controls';
import { Icon } from '../icons';
import type { Clip, GraphicDocument, GraphicLayer, TextLayer, ShapeLayer, GraphicAnimation, Sequence, Param } from '../../types/project';
import { TEMPLATES, TEMPLATE_CATEGORIES, templateById, textLayer, shapeLayer, blankTextDocument } from '../graphics/templates';
import { useGraphicsLibrary, libraryEntryAsTemplate } from '../graphics/library';
import { renderGraphic } from '../../engine/graphics/graphicRenderer';
import { MIME_TEMPLATE, useTimelineView } from '../timeline/timelineState';
import { cmd } from '../../app/commands';
import { setKeyframe, evalParam, toggleAnimated, hasKeyframeAt, removeKeyframe } from '../../engine/keyframes';
import { uid } from '../../engine/util';
import * as E from '../../engine/timeline/edits';

const FONTS = ['Inter Variable', 'Georgia', 'Times New Roman', 'Arial', 'Helvetica', 'Verdana', 'Trebuchet MS', 'Courier New', 'Impact', 'Palatino', 'Garamond', 'Tahoma'];
const ANIMS: { value: GraphicAnimation['type']; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'fade', label: 'Fade' },
  { value: 'slideLeft', label: 'Slide from left' },
  { value: 'slideRight', label: 'Slide from right' },
  { value: 'slideUp', label: 'Slide up' },
  { value: 'slideDown', label: 'Slide down' },
  { value: 'scale', label: 'Scale' },
  { value: 'typewriter', label: 'Typewriter' },
  { value: 'blur', label: 'Blur' },
  { value: 'wipe', label: 'Wipe' },
];

export function EssentialGraphicsPanel() {
  const seq = useActiveSequence();
  const project = useProject((s) => s.project);
  const sel = useUI((s) => s.selection.clipIds);
  const layerSel = useUI((s) => s.selection.graphicLayerIds);
  const playhead = usePlayback((s) => s.playhead);
  const [tab, setTab] = useState<'browse' | 'edit'>('edit');
  const [q, setQ] = useState('');
  const clip = seq?.clips.find((c) => c.id === sel[0] && (c.generator === 'graphic' || findAsset(project, c.assetId ?? '')?.generator === 'graphic')) ?? null;
  const doc: GraphicDocument | null = clip ? clip.graphic ?? findAsset(project, clip.assetId ?? '')?.graphic ?? null : null;

  useEffect(() => {
    if (!clip) setTab('browse');
    else setTab('edit');
  }, [clip?.id]);

  const write = (label: string, fn: (d: GraphicDocument, c: Clip) => void, transient = false) => {
    if (!clip || !seq) return;
    const run = (p: any) => {
      const s = p.sequences.find((x: Sequence) => x.id === seq.id)!;
      const c = s.clips.find((x: Clip) => x.id === clip.id);
      if (!c) return;
      if (!c.graphic) {
        const a = p.assets.find((x: any) => x.id === c.assetId);
        c.graphic = a?.graphic ? JSON.parse(JSON.stringify(a.graphic)) : { layers: [], introProtect: 0, outroProtect: 0 };
      }
      fn(c.graphic!, c);
    };
    if (transient) useProject.getState().updateTransient(run);
    else useProject.getState().update(label, run);
  };

  return (
    <div className="eg" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="tabs">
        <button type="button" className={tab === 'browse' ? 'on' : ''} onClick={() => setTab('browse')}>Browse</button>
        <button type="button" className={tab === 'edit' ? 'on' : ''} onClick={() => setTab('edit')}>Edit</button>
      </div>
      {tab === 'browse' ? (
        <Browse q={q} setQ={setQ} seq={seq} />
      ) : !clip || !doc ? (
        <Empty title="Nothing to edit" icon="clipTitle">
          Select a graphic clip in the timeline, or create one: <br />
          <Button sm style={{ marginTop: 8 }} icon="add" onClick={() => addTextClip(seq)} disabled={!seq}>New Text Layer at Playhead</Button>
        </Empty>
      ) : (
        <Edit clip={clip} doc={doc} seq={seq!} write={write} layerSel={layerSel} local={playhead - clip.start} />
      )}
    </div>
  );
}

function addTextClip(seq: Sequence | null) {
  if (!seq) return;
  const asset = cmd.newGenerator('graphic', {}, 'Text');
  const ph = usePlayback.getState().playhead;
  useProject.getState().update('New text layer', (p) => {
    const a = p.assets.find((x) => x.id === asset.id)!;
    a.graphic = blankTextDocument(seq.settings.width, seq.settings.height);
    const s = p.sequences.find((x) => x.id === seq.id)!;
    const ids = E.placeAsset(p, s, a, ph, { mode: 'overwrite', stillFrames: seq.settings.fps * 5 });
    useUI.getState().selectClips(ids);
  });
}

function Browse({ q, setQ, seq }: { q: string; setQ: (s: string) => void; seq: Sequence | null }) {
  const library = useGraphicsLibrary((s) => s.entries);
  const list = [...TEMPLATES, ...library.map(libraryEntryAsTemplate)].filter((t) => !q || t.name.toLowerCase().includes(q.toLowerCase()) || t.category.toLowerCase().includes(q.toLowerCase()));
  const add = (id: string) => {
    if (!seq) return toast('info', 'No sequence', 'Create a sequence first.');
    const tpl = templateById(id)!;
    const asset = cmd.newGenerator('graphic', {}, tpl.name);
    const ph = usePlayback.getState().playhead;
    useProject.getState().update(`Add ${tpl.name}`, (p) => {
      const a = p.assets.find((x) => x.id === asset.id)!;
      a.graphic = tpl.build(seq.settings.width, seq.settings.height);
      const s = p.sequences.find((x) => x.id === seq.id)!;
      const ids = E.placeAsset(p, s, a, ph, { mode: 'overwrite', stillFrames: seq.settings.fps * 5 });
      useUI.getState().selectClips(ids);
    });
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div className="toolbar">
        <TextField value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search templates" icon="search" style={{ flex: 1 }} />
      </div>
      <div className="scroll-y" style={{ flex: 1 }}>
        {TEMPLATE_CATEGORIES.map((cat) => {
          const items = list.filter((t) => t.category === cat);
          if (!items.length) return null;
          return (
            <div key={cat}>
              <div className="section-title" style={{ padding: '8px 8px 2px', color: 'var(--c-text-dim)', fontSize: 11 }}>{cat}</div>
              <div className="template-grid">
                {items.map((t) => (
                  <div key={t.id} className="template-card" draggable onDragStart={(e) => { e.dataTransfer.setData(MIME_TEMPLATE, t.id); e.dataTransfer.effectAllowed = 'copy'; useTimelineView.getState().setExternalDrag({ kind: 'template', id: t.id }); }} onDragEnd={() => useTimelineView.getState().setExternalDrag(null)} onDoubleClick={() => add(t.id)} title={`${t.description}\n\nDouble-click to add at the playhead, or drag into the timeline.`} onContextMenu={library.some((e) => e.id === t.id) ? (e) => { e.preventDefault(); e.stopPropagation(); useUI.getState().openContextMenu(e.clientX, e.clientY, [{ label: 'Rename Template', onSelect: () => useUI.getState().openModal({ kind: 'rename', payload: { title: 'Rename Template', label: 'Template name', value: t.name, onSubmit: (n: string) => useGraphicsLibrary.getState().rename(t.id, n) } }) }, { label: 'Delete from Library', danger: true, onSelect: () => { useGraphicsLibrary.getState().remove(t.id); toast('success', 'Template deleted', `"${t.name}" was removed from your library.`); } }]); } : undefined}>
                    <TemplateThumb id={t.id} />
                    <div style={{ fontSize: 11, padding: '3px 2px 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <div className="eg-btnrow" style={{ borderTop: '1px solid var(--c-line)' }}>
        <Button sm icon="add" onClick={() => addTextClip(seq)} disabled={!seq}>New Text Layer</Button>
        <span style={{ color: 'var(--c-text-faint)', fontSize: 11 }}>Drag a template onto a video track</span>
      </div>
    </div>
  );
}

function TemplateThumb({ id }: { id: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const tpl = templateById(id)!;
    const W = 1920,
      H = 1080;
    cv.width = 240;
    cv.height = 135;
    const ctx = cv.getContext('2d')!;
    ctx.fillStyle = '#2a2f36';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.save();
    ctx.scale(cv.width / W, cv.height / H);
    // draw at the end of intro so animations are settled
    renderGraphic(ctx, tpl.build(W, H), 60, 30, 150, W, H);
    ctx.restore();
  }, [id]);
  return <canvas ref={ref} className="tp-thumb" style={{ width: '100%', aspectRatio: '16/9', display: 'block', background: '#2a2f36' }} />;
}

/* ---------- editor ---------- */

function Edit({ clip, doc, seq, write, layerSel, local }: { clip: Clip; doc: GraphicDocument; seq: Sequence; write: (label: string, fn: (d: GraphicDocument, c: Clip) => void, transient?: boolean) => void; layerSel: string[]; local: number }) {
  const setLayerSel = (ids: string[]) => useUI.getState().setSelection({ graphicLayerIds: ids });
  const layer = doc.layers.find((l) => l.id === layerSel[0]) ?? null;
  const idx = layer ? doc.layers.indexOf(layer) : -1;
  const [dragId, setDragId] = useState<string | null>(null);

  const addLayer = (kind: 'text' | 'rect' | 'ellipse' | 'line' | 'polygon') => {
    write(`Add ${kind} layer`, (d) => {
      const w = seq.settings.width,
        h = seq.settings.height;
      const l = kind === 'text' ? textLayer('New Text', w / 2, h / 2, { align: 'center', anchor: 'center', verticalAlign: 'middle', fontSize: Math.round(h * 0.06) }) : shapeLayer(kind, w / 2 - w * 0.1, h / 2 - h * 0.1, w * 0.2, kind === 'line' ? 0 : h * 0.2, kind === 'line' ? { stroke: '#e0e0e0', strokeEnabled: true, strokeWidth: 4, fillEnabled: false } : {});
      d.layers.push(l);
      setLayerSel([l.id]);
    });
  };
  const updateLayer = (label: string, fn: (l: GraphicLayer) => void, transient = false) => {
    if (!layer) return;
    write(label, (d) => { const l = d.layers.find((x) => x.id === layer.id); if (l) fn(l); }, transient);
  };
  const setNum = (key: 'x' | 'y' | 'scale' | 'rotation' | 'opacity') => (v: number, commit: boolean) =>
    updateLayer(`Layer ${key}`, (l) => { const p = l[key] as Param<number>; l[key] = p.animated ? { ...setKeyframe(p, local, v), animated: true } : { ...p, value: v }; }, !commit);
  const kfBtn = (key: 'x' | 'y' | 'scale' | 'rotation' | 'opacity') => {
    if (!layer) return null;
    const p = layer[key] as Param<number>;
    const has = hasKeyframeAt(p, local);
    return (
      <span style={{ display: 'inline-flex' }}>
        <button type="button" className={`ibtn sm noline stopwatch ${p.animated ? 'on' : ''}`} title={p.animated ? 'Stop animating' : 'Animate (adds keyframe at playhead)'} onClick={() => updateLayer('Toggle animation', (l) => { l[key] = toggleAnimated(l[key] as Param<number>, local); })}><Icon name="stopwatch" size={10} /></button>
        {p.animated ? <IconButton icon="keyframe" label={has ? 'Remove keyframe' : 'Add keyframe'} sm noline on={has} onClick={() => updateLayer('Keyframe', (l) => { const pp = l[key] as Param<number>; l[key] = has ? removeKeyframe(pp, local) : { ...setKeyframe(pp, local, evalParam(pp, local)), animated: true }; })} /> : null}
      </span>
    );
  };
  const val = (key: 'x' | 'y' | 'scale' | 'rotation' | 'opacity') => (layer ? evalParam(layer[key] as Param<number>, local) : 0);

  const move = (from: number, to: number) => write('Reorder layers', (d) => { const [l] = d.layers.splice(from, 1); d.layers.splice(to, 0, l); });
  // Layers list shows top-most first
  const ordered = [...doc.layers].reverse();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div className="eg-btnrow">
        <IconButton icon="text" label="New text layer" sm onClick={() => addLayer('text')} />
        <IconButton icon="rect" label="New rectangle" sm onClick={() => addLayer('rect')} />
        <IconButton icon="ellipse" label="New ellipse" sm onClick={() => addLayer('ellipse')} />
        <IconButton icon="line" label="New line" sm onClick={() => addLayer('line')} />
        <IconButton icon="polygon" label="New polygon" sm onClick={() => addLayer('polygon')} />
        <span className="spacer" />
        <IconButton icon="arrowUp" label="Bring forward" sm disabled={!layer || idx === doc.layers.length - 1} onClick={() => move(idx, idx + 1)} />
        <IconButton icon="arrowDown" label="Send backward" sm disabled={!layer || idx === 0} onClick={() => move(idx, idx - 1)} />
        <span style={{ width: 6 }} />
        <Button sm icon="save" onClick={() => cmd.saveGraphicAsTemplate()} title="Save this graphic to your motion-graphics library">Save to Library</Button>
        <IconButton icon="duplicate" label="Duplicate layer" sm disabled={!layer} onClick={() => write('Duplicate layer', (d) => { const l = d.layers.find((x) => x.id === layer!.id)!; const c = JSON.parse(JSON.stringify(l)); c.id = uid('gl'); c.name += ' copy'; c.x = { ...c.x, value: c.x.value + 20 }; c.y = { ...c.y, value: c.y.value + 20 }; d.layers.splice(d.layers.indexOf(l) + 1, 0, c); setLayerSel([c.id]); })} />
        <IconButton icon="trash" label="Delete layer" sm disabled={!layer} onClick={() => write('Delete layer', (d) => { d.layers = d.layers.filter((x) => x.id !== layer!.id); setLayerSel([]); })} />
      </div>
      <div className="eg-layers" style={{ maxHeight: 160, overflow: 'auto', borderBottom: '1px solid var(--c-line)' }}>
        {ordered.map((l) => (
          <div
            key={l.id}
            className={`eg-layer ${layerSel.includes(l.id) ? 'selected' : ''}`}
            draggable
            onDragStart={() => setDragId(l.id)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => { if (dragId && dragId !== l.id) move(doc.layers.findIndex((x) => x.id === dragId), doc.layers.findIndex((x) => x.id === l.id)); setDragId(null); }}
            onClick={(e) => setLayerSel(e.shiftKey ? [...layerSel, l.id] : [l.id])}
            onDoubleClick={() => useUI.getState().openModal({ kind: 'rename', payload: { title: 'Rename Layer', label: 'Layer name', value: l.name, onSubmit: (n: string) => write('Rename layer', (d) => { const x = d.layers.find((y) => y.id === l.id); if (x) x.name = n; }) } })}
          >
            <button type="button" className="ibtn sm noline" title={l.visible ? 'Hide layer' : 'Show layer'} onClick={(e) => { e.stopPropagation(); write('Toggle layer', (d) => { const x = d.layers.find((y) => y.id === l.id); if (x) x.visible = !x.visible; }); }}><Icon name={l.visible ? 'eye' : 'eyeOff'} size={11} /></button>
            <button type="button" className="ibtn sm noline" title={l.locked ? 'Unlock layer' : 'Lock layer'} onClick={(e) => { e.stopPropagation(); write('Lock layer', (d) => { const x = d.layers.find((y) => y.id === l.id); if (x) x.locked = !x.locked; }); }}><Icon name={l.locked ? 'lock' : 'unlock'} size={11} /></button>
            <Icon name={l.kind === 'text' ? 'text' : l.kind === 'rect' ? 'rect' : l.kind === 'ellipse' ? 'ellipse' : l.kind === 'line' ? 'line' : l.kind === 'polygon' ? 'polygon' : 'clipImage'} size={11} style={{ color: 'var(--c-text-dim)' }} />
            <span className="nm">{l.kind === 'text' ? (l as TextLayer).text.split('\n')[0] || l.name : l.name}</span>
          </div>
        ))}
        {!doc.layers.length ? <div className="empty" style={{ padding: 12 }}>No layers. Add text or a shape above.</div> : null}
      </div>
      <div className="eg-props scroll-y" style={{ flex: 1 }}>
        <div className="eg-group">
          <div className="eg-title">Responsive Design - Time</div>
          <div className="prop-grid">
            <span className="label">Intro protect</span>
            <HotText value={doc.introProtect} min={0} max={clip.duration / seq.settings.fps} step={0.1} decimals={1} unit=" s" width={60} onChange={(v, c) => { if (c) write('Intro protect', (d) => { d.introProtect = v; }); }} />
            <span className="label">Outro protect</span>
            <HotText value={doc.outroProtect} min={0} max={clip.duration / seq.settings.fps} step={0.1} decimals={1} unit=" s" width={60} onChange={(v, c) => { if (c) write('Outro protect', (d) => { d.outroProtect = v; }); }} />
          </div>
        </div>
        {layer ? (
          <>
            <div className="eg-group">
              <div className="eg-title">Align and Transform</div>
              <div className="eg-btnrow">
                {(['left', 'center', 'right'] as const).map((a) => <IconButton key={a} icon={a === 'left' ? 'alignLeft' : a === 'center' ? 'alignCenter' : 'alignRight'} label={`Align ${a} in frame`} sm onClick={() => updateLayer('Align', (l) => { const w = seq.settings.width; const lw = l.kind === 'text' ? ((l as TextLayer).boxWidth || 0) : (l as ShapeLayer).width; const anchorCenter = l.anchor === 'center'; l.x = { ...l.x, value: a === 'left' ? (anchorCenter ? lw / 2 : 0) : a === 'center' ? w / 2 - (anchorCenter ? 0 : lw / 2) : w - (anchorCenter ? lw / 2 : lw) }; if (l.kind === 'text') (l as TextLayer).align = a; })} />)}
                {(['top', 'middle', 'bottom'] as const).map((a) => <IconButton key={a} icon={a === 'top' ? 'alignTop' : a === 'middle' ? 'alignMiddle' : 'alignBottom'} label={`Align ${a} in frame`} sm onClick={() => updateLayer('Align', (l) => { const h = seq.settings.height; const lh = l.kind === 'text' ? (l as TextLayer).fontSize * 1.2 : (l as ShapeLayer).height; const anchorCenter = l.anchor === 'center'; l.y = { ...l.y, value: a === 'top' ? (anchorCenter ? lh / 2 : 0) : a === 'middle' ? h / 2 - (anchorCenter ? 0 : lh / 2) : h - (anchorCenter ? lh / 2 : lh) }; })} />)}
              </div>
              <div className="prop-grid">
                <span className="label">Position</span>
                <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <HotText value={val('x')} step={1} decimals={0} width={58} onChange={setNum('x')} />
                  <HotText value={val('y')} step={1} decimals={0} width={58} onChange={setNum('y')} />
                  {kfBtn('x')}
                </span>
                <span className="label">Scale</span>
                <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}><HotText value={val('scale')} min={1} max={2000} step={0.5} unit="%" width={58} onChange={setNum('scale')} />{kfBtn('scale')}</span>
                <span className="label">Rotation</span>
                <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}><HotText value={val('rotation')} min={-3600} max={3600} step={0.5} unit="°" width={58} onChange={setNum('rotation')} />{kfBtn('rotation')}</span>
                <span className="label">Opacity</span>
                <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}><HotText value={val('opacity')} min={0} max={100} step={0.5} unit="%" width={58} onChange={setNum('opacity')} />{kfBtn('opacity')}</span>
                <span className="label">Anchor</span>
                <Select value={layer.anchor} options={[{ value: 'topLeft', label: 'Top-left' }, { value: 'center', label: 'Center' }]} onChange={(v) => updateLayer('Anchor', (l) => { l.anchor = v as any; })} />
                <span className="label">Pin to</span>
                <Select value={layer.pin ?? 'none'} options={[{ value: 'none', label: 'None' }, { value: 'left', label: 'Left edge' }, { value: 'right', label: 'Right edge' }, { value: 'top', label: 'Top edge' }, { value: 'bottom', label: 'Bottom edge' }, { value: 'center', label: 'Center' }]} onChange={(v) => updateLayer('Pin', (l) => { l.pin = v as any; })} />
                <span className="label">Blend</span>
                <Select value={layer.blend} options={[{ value: 'source-over', label: 'Normal' }, { value: 'multiply', label: 'Multiply' }, { value: 'screen', label: 'Screen' }, { value: 'overlay', label: 'Overlay' }, { value: 'difference', label: 'Difference' }, { value: 'lighter', label: 'Add' }]} onChange={(v) => updateLayer('Blend', (l) => { l.blend = v as any; })} />
              </div>
            </div>
            {layer.kind === 'text' ? <TextProps layer={layer as TextLayer} update={updateLayer} /> : null}
            {layer.kind !== 'text' && layer.kind !== 'image' ? <ShapeProps layer={layer as ShapeLayer} update={updateLayer} /> : null}
            <div className="eg-group">
              <div className="eg-title">Appearance</div>
              <div className="prop-grid">
                <span className="label"><Checkbox checked={layer.fillEnabled} onChange={(v) => updateLayer('Fill', (l) => { l.fillEnabled = v; })} label="Fill" /></span>
                <ColorChip color={layer.fill} onChange={(h, c) => updateLayer('Fill color', (l) => { l.fill = h; }, !c)} />
                <span className="label"><Checkbox checked={layer.strokeEnabled} onChange={(v) => updateLayer('Stroke', (l) => { l.strokeEnabled = v; })} label="Stroke" /></span>
                <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <ColorChip color={layer.stroke} onChange={(h, c) => updateLayer('Stroke color', (l) => { l.stroke = h; }, !c)} />
                  <HotText value={layer.strokeWidth} min={0} max={200} step={0.5} unit=" px" width={56} onChange={(v, c) => updateLayer('Stroke width', (l) => { l.strokeWidth = v; }, !c)} />
                </span>
                <span className="label"><Checkbox checked={layer.shadowEnabled} onChange={(v) => updateLayer('Shadow', (l) => { l.shadowEnabled = v; })} label="Shadow" /></span>
                <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <ColorChip color={layer.shadowColor} onChange={(h, c) => updateLayer('Shadow color', (l) => { l.shadowColor = h; }, !c)} alpha={layer.shadowOpacity} onAlpha={(a) => updateLayer('Shadow opacity', (l) => { l.shadowOpacity = a; })} />
                  <HotText value={layer.shadowBlur} min={0} max={200} step={1} unit=" blur" width={60} onChange={(v, c) => updateLayer('Shadow blur', (l) => { l.shadowBlur = v; }, !c)} />
                  <HotText value={layer.shadowOffsetX} min={-500} max={500} step={1} unit=" x" width={52} onChange={(v, c) => updateLayer('Shadow offset', (l) => { l.shadowOffsetX = v; }, !c)} />
                  <HotText value={layer.shadowOffsetY} min={-500} max={500} step={1} unit=" y" width={52} onChange={(v, c) => updateLayer('Shadow offset', (l) => { l.shadowOffsetY = v; }, !c)} />
                </span>
              </div>
            </div>
            <div className="eg-group">
              <div className="eg-title">Animation</div>
              <AnimRow label="In" anim={layer.animIn} onChange={(a) => updateLayer('Animation in', (l) => { l.animIn = a; })} />
              <AnimRow label="Out" anim={layer.animOut} onChange={(a) => updateLayer('Animation out', (l) => { l.animOut = a; })} />
            </div>
          </>
        ) : (
          <div className="empty" style={{ padding: 16 }}>Select a layer to edit it. Drag layers to reorder; the top of the list is drawn in front.</div>
        )}
      </div>
    </div>
  );
}

function TextProps({ layer, update }: { layer: TextLayer; update: (label: string, fn: (l: GraphicLayer) => void, transient?: boolean) => void }) {
  const u = (label: string, fn: (l: TextLayer) => void, transient = false) => update(label, (l) => fn(l as TextLayer), transient);
  const setTextEditing = useUI((s) => s.setTextEditing);
  return (
    <div className="eg-group">
      <div className="eg-title">Text</div>
      <textarea className="field" value={layer.text} rows={3} style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit', height: 'auto', padding: 4, lineHeight: 1.4 }} onFocus={() => setTextEditing(true)} onBlur={() => setTextEditing(false)} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => u('Edit text', (l) => { l.text = e.target.value; })} />
      <div className="prop-grid" style={{ marginTop: 6 }}>
        <span className="label">Font</span>
        <Select value={layer.fontFamily} options={FONTS.map((f) => ({ value: f, label: f === 'Inter Variable' ? 'Inter' : f }))} onChange={(v) => u('Font', (l) => { l.fontFamily = v; })} />
        <span className="label">Size / Weight</span>
        <span style={{ display: 'flex', gap: 4 }}>
          <HotText value={layer.fontSize} min={4} max={1000} step={1} unit=" px" width={62} onChange={(v, c) => u('Font size', (l) => { l.fontSize = v; }, !c)} />
          <HotText value={layer.fontWeight} min={100} max={900} step={10} width={48} onChange={(v, c) => u('Font weight', (l) => { l.fontWeight = v; }, !c)} title="Weight 100-900 (Inter is variable)" />
        </span>
        <span className="label">Style</span>
        <span style={{ display: 'flex', gap: 2 }}>
          <IconButton icon="italic" label="Italic" sm on={layer.italic} onClick={() => u('Italic', (l) => { l.italic = !l.italic; })} />
          <IconButton icon="underline" label="Underline" sm on={layer.underline} onClick={() => u('Underline', (l) => { l.underline = !l.underline; })} />
          <IconButton icon="caps" label="All caps" sm on={layer.allCaps} onClick={() => u('All caps', (l) => { l.allCaps = !l.allCaps; })} />
          <IconButton icon="tabular" label="Tabular figures" sm on={layer.tabularNums} onClick={() => u('Tabular numerals', (l) => { l.tabularNums = !l.tabularNums; })} />
        </span>
        <span className="label">Align</span>
        <span style={{ display: 'flex', gap: 2 }}>
          {(['left', 'center', 'right'] as const).map((a) => <IconButton key={a} icon={a === 'left' ? 'alignLeft' : a === 'center' ? 'alignCenter' : 'alignRight'} label={`Align ${a}`} sm on={layer.align === a} onClick={() => u('Text align', (l) => { l.align = a; })} />)}
          <span style={{ width: 6 }} />
          {(['top', 'middle', 'bottom'] as const).map((a) => <IconButton key={a} icon={a === 'top' ? 'alignTop' : a === 'middle' ? 'alignMiddle' : 'alignBottom'} label={`Vertical ${a}`} sm on={layer.verticalAlign === a} onClick={() => u('Vertical align', (l) => { l.verticalAlign = a; })} />)}
        </span>
        <span className="label">Tracking</span>
        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <Slider value={layer.tracking} min={-20} max={100} step={0.5} onChange={(v, c) => u('Tracking', (l) => { l.tracking = v; }, !c)} style={{ flex: 1, fontSize: 10 }} />
          <HotText value={layer.tracking} min={-50} max={200} step={0.5} width={48} onChange={(v, c) => u('Tracking', (l) => { l.tracking = v; }, !c)} />
        </span>
        <span className="label">Leading</span>
        <HotText value={layer.leading} min={0.5} max={4} step={0.05} decimals={2} width={48} onChange={(v, c) => u('Leading', (l) => { l.leading = v; }, !c)} />
        <span className="label">Box width</span>
        <HotText value={layer.boxWidth} min={0} max={8000} step={5} unit=" px" width={62} onChange={(v, c) => u('Text box', (l) => { l.boxWidth = v; }, !c)} title="0 = no wrapping" />
        <span className="label"><Checkbox checked={layer.background.enabled} onChange={(v) => u('Background', (l) => { l.background.enabled = v; })} label="Background" /></span>
        <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <ColorChip color={layer.background.color} onChange={(h, c) => u('Background color', (l) => { l.background.color = h; }, !c)} alpha={layer.background.opacity} onAlpha={(a) => u('Background opacity', (l) => { l.background.opacity = a; })} />
          <HotText value={layer.background.padding} min={0} max={400} step={1} unit=" pad" width={58} onChange={(v, c) => u('Background padding', (l) => { l.background.padding = v; }, !c)} />
          <HotText value={layer.background.radius} min={0} max={400} step={1} unit=" r" width={48} onChange={(v, c) => u('Background radius', (l) => { l.background.radius = v; }, !c)} />
        </span>
      </div>
    </div>
  );
}

function ShapeProps({ layer, update }: { layer: ShapeLayer; update: (label: string, fn: (l: GraphicLayer) => void, transient?: boolean) => void }) {
  const u = (label: string, fn: (l: ShapeLayer) => void, transient = false) => update(label, (l) => fn(l as ShapeLayer), transient);
  return (
    <div className="eg-group">
      <div className="eg-title">Shape</div>
      <div className="prop-grid">
        {layer.kind === 'line' ? (
          <>
            <span className="label">End offset</span>
            <span style={{ display: 'flex', gap: 4 }}>
              <HotText value={layer.x2} step={1} decimals={0} width={58} onChange={(v, c) => u('Line end', (l) => { l.x2 = v; }, !c)} />
              <HotText value={layer.y2} step={1} decimals={0} width={58} onChange={(v, c) => u('Line end', (l) => { l.y2 = v; }, !c)} />
            </span>
          </>
        ) : (
          <>
            <span className="label">Size</span>
            <span style={{ display: 'flex', gap: 4 }}>
              <HotText value={layer.width} min={1} max={8000} step={1} decimals={0} width={58} onChange={(v, c) => u('Shape size', (l) => { l.width = v; }, !c)} />
              <HotText value={layer.height} min={1} max={8000} step={1} decimals={0} width={58} onChange={(v, c) => u('Shape size', (l) => { l.height = v; }, !c)} />
            </span>
          </>
        )}
        {layer.kind === 'rect' ? (
          <>
            <span className="label">Corner radius</span>
            <HotText value={layer.radius} min={0} max={1000} step={1} width={58} onChange={(v, c) => u('Corner radius', (l) => { l.radius = v; }, !c)} />
          </>
        ) : null}
        {layer.kind === 'polygon' ? (
          <>
            <span className="label">Sides</span>
            <HotText value={layer.sides} min={3} max={24} step={1} width={48} onChange={(v, c) => u('Polygon sides', (l) => { l.sides = Math.round(v); }, !c)} />
          </>
        ) : null}
      </div>
    </div>
  );
}

function AnimRow({ label, anim, onChange }: { label: string; anim: GraphicAnimation | undefined; onChange: (a: GraphicAnimation | undefined) => void }) {
  const a: GraphicAnimation = anim ?? { type: 'none', duration: 0.5, delay: 0, easing: 'easeOut' };
  return (
    <div className="prop-grid" style={{ marginBottom: 4 }}>
      <span className="label">{label}</span>
      <span style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
        <Select value={a.type} options={ANIMS} onChange={(v) => onChange(v === 'none' ? undefined : { ...a, type: v as GraphicAnimation['type'] })} style={{ width: 120 }} />
        {a.type !== 'none' ? (
          <>
            <HotText value={a.duration} min={0.05} max={10} step={0.05} decimals={2} unit=" s" width={54} onChange={(v, c) => c && onChange({ ...a, duration: v })} title="Duration" />
            <HotText value={a.delay} min={0} max={30} step={0.05} decimals={2} unit=" s" width={54} onChange={(v, c) => c && onChange({ ...a, delay: v })} title="Delay" />
            <Select value={a.easing} options={[{ value: 'linear', label: 'Linear' }, { value: 'easeIn', label: 'Ease in' }, { value: 'easeOut', label: 'Ease out' }, { value: 'easeInOut', label: 'Ease in-out' }, { value: 'back', label: 'Back' }]} onChange={(v) => onChange({ ...a, easing: v as GraphicAnimation['easing'] })} style={{ width: 90 }} />
          </>
        ) : null}
      </span>
    </div>
  );
}
