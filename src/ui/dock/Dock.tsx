import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLayout, PANEL_TITLES, type LayoutNode, type DropZone } from '../../state/layoutStore';
import { useUI, type PanelId, type ContextMenuItem } from '../../state/uiStore';
import { Icon } from '../icons';
import { IconButton, MenuButton, usePointerDrag } from '../controls';
import { PanelContent, panelSubtitle } from './PanelRegistry';

/** Tab drag state shared between groups (module-level; a single drag at a time). */
let dragPanel: PanelId | null = null;
const DRAG_MIME = 'application/x-vsp-panel';

export function DockRoot() {
  const ws = useUI((s) => s.workspace);
  const layout = useLayout((s) => s.layouts[ws]);
  const get = useLayout((s) => s.get);
  const root = layout ?? get(ws);
  const maximized = useUI((s) => s.maximizedPanel);
  const floating = useLayout((s) => s.floating);
  if (maximized) {
    return (
      <div className="workspace">
        <PanelGroupView node={{ kind: 'group', id: '__max', tabs: [maximized], active: maximized }} maximizedView />
      </div>
    );
  }
  return (
    <div className="workspace">
      <DockNode node={root} />
      {floating.map((f) => (
        <FloatingPanel key={f.id} id={f.id} panel={f.panel} x={f.x} y={f.y} w={f.w} h={f.h} />
      ))}
    </div>
  );
}

function DockNode({ node }: { node: LayoutNode }) {
  if (node.kind === 'group') return <PanelGroupView node={node} />;
  return <SplitView node={node} />;
}

function SplitView({ node }: { node: Extract<LayoutNode, { kind: 'split' }> }) {
  const ws = useUI((s) => s.workspace);
  const resize = useLayout((s) => s.resize);
  const ref = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState<number[] | null>(null);
  const sizes = live ?? node.sizes;
  const horizontal = node.dir === 'row';
  const startSizes = useRef<number[]>([]);
  const [activeGutter, setActiveGutter] = useState(-1);

  const makeGutterDown = (i: number) =>
    usePointerDragFactory({
      onStart: () => {
        startSizes.current = node.sizes.slice();
        setActiveGutter(i);
      },
      onMove: (d) => {
        const el = ref.current!;
        const total = horizontal ? el.clientWidth : el.clientHeight;
        const delta = (horizontal ? d.dx : d.dy) / total;
        const s = startSizes.current.slice();
        const minFrac = Math.min(0.08, 120 / total);
        let a = s[i] + delta,
          b = s[i + 1] - delta;
        if (a < minFrac) {
          b -= minFrac - a;
          a = minFrac;
        }
        if (b < minFrac) {
          a -= minFrac - b;
          b = minFrac;
        }
        s[i] = a;
        s[i + 1] = b;
        setLive(s);
      },
      onEnd: () => {
        setActiveGutter(-1);
        setLive((cur) => {
          if (cur) resize(ws, node.id, i, cur);
          return null;
        });
      },
      cursorClass: horizontal ? 'dragging-ew' : 'dragging-ns',
    });

  return (
    <div ref={ref} className={`dock-split ${horizontal ? '' : 'vertical'}`}>
      {node.children.map((c, i) => (
        <React.Fragment key={c.id}>
          {i > 0 ? <Gutter onDown={makeGutterDown(i - 1)} active={activeGutter === i - 1} /> : null}
          <div className="dock-child" style={{ flex: `${sizes[i]} 1 0px` }}>
            <DockNode node={c} />
          </div>
        </React.Fragment>
      ))}
    </div>
  );
}

// Hooks can't be called in a loop with variable counts safely, so gutters get their own component.
function usePointerDragFactory(h: Parameters<typeof usePointerDrag>[0]) {
  return h;
}
function Gutter({ onDown, active }: { onDown: Parameters<typeof usePointerDrag>[0]; active: boolean }) {
  const handler = usePointerDrag(onDown);
  return <div className={`dock-gutter ${active ? 'active' : ''}`} onPointerDown={handler} role="separator" />;
}

function PanelGroupView({ node, maximizedView, floatingId }: { node: Extract<LayoutNode, { kind: 'group' }>; maximizedView?: boolean; floatingId?: string }) {
  const ws = useUI((s) => s.workspace);
  const focused = useUI((s) => s.focusedPanel);
  const setFocused = useUI((s) => s.setFocusedPanel);
  const setMax = useUI((s) => s.setMaximizedPanel);
  const maximized = useUI((s) => s.maximizedPanel);
  const layout = useLayout();
  const [dropZone, setDropZone] = useState<DropZone | null>(null);
  const [tabDropIndex, setTabDropIndex] = useState<number | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const active = node.tabs.includes(node.active) ? node.active : node.tabs[0];
  const isFocused = focused === active;

  const onTabDragStart = (e: React.DragEvent, p: PanelId) => {
    dragPanel = p;
    e.dataTransfer.setData(DRAG_MIME, p);
    e.dataTransfer.effectAllowed = 'move';
  };
  const zoneFromEvent = (e: React.DragEvent): DropZone => {
    const r = bodyRef.current!.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width,
      y = (e.clientY - r.top) / r.height;
    const edge = 0.25;
    if (x < edge) return 'left';
    if (x > 1 - edge) return 'right';
    if (y < edge) return 'top';
    if (y > 1 - edge) return 'bottom';
    return 'center';
  };
  const onBodyDragOver = (e: React.DragEvent) => {
    if (!dragPanel || floatingId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropZone(zoneFromEvent(e));
  };
  const onBodyDrop = (e: React.DragEvent) => {
    if (!dragPanel || floatingId) return;
    e.preventDefault();
    const z = zoneFromEvent(e);
    layout.moveTab(ws, dragPanel, node.id, z);
    dragPanel = null;
    setDropZone(null);
  };
  const onTabsDragOver = (e: React.DragEvent) => {
    if (!dragPanel || floatingId) return;
    e.preventDefault();
    const tabs = Array.from((e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('.panel-tab'));
    let idx = tabs.length;
    for (let i = 0; i < tabs.length; i++) {
      const r = tabs[i].getBoundingClientRect();
      if (e.clientX < r.left + r.width / 2) {
        idx = i;
        break;
      }
    }
    setTabDropIndex(idx);
  };
  const onTabsDrop = (e: React.DragEvent) => {
    if (!dragPanel || floatingId) return;
    e.preventDefault();
    const idx = tabDropIndex ?? node.tabs.length;
    layout.moveTab(ws, dragPanel, node.id, 'center', idx);
    dragPanel = null;
    setTabDropIndex(null);
  };

  const groupMenu = (): ContextMenuItem[] => [
    { label: maximized ? 'Restore Panel' : 'Maximize Panel', shortcut: '`', onSelect: () => setMax(maximized ? null : active) },
    { label: floatingId ? 'Dock Panel' : 'Undock Panel', onSelect: () => (floatingId ? layout.unfloat(ws, floatingId) : layout.float(ws, active)) },
    {
      label: 'Close Panel',
      disabled: node.tabs.length <= 1 && !floatingId,
      onSelect: () => {
        if (floatingId) layout.unfloat(ws, floatingId);
        layout.closeTab(ws, active);
      },
    },
    { separator: true },
    { label: 'Reset Workspace Layout', onSelect: () => layout.reset(ws) },
  ];

  const dropRect = (): React.CSSProperties | null => {
    if (!dropZone) return null;
    switch (dropZone) {
      case 'left':
        return { left: 0, top: 0, bottom: 0, width: '50%' };
      case 'right':
        return { right: 0, top: 0, bottom: 0, width: '50%' };
      case 'top':
        return { left: 0, right: 0, top: 0, height: '50%' };
      case 'bottom':
        return { left: 0, right: 0, bottom: 0, height: '50%' };
      default:
        return { inset: 0 };
    }
  };

  return (
    <div className={`panel-group ${isFocused && !maximizedView ? 'focused' : ''}`} onPointerDownCapture={() => focused !== active && setFocused(active)} data-panel={active}>
      <div className="panel-tabs" role="tablist" onDragOver={onTabsDragOver} onDragLeave={() => setTabDropIndex(null)} onDrop={onTabsDrop} onDoubleClick={(e) => e.target === e.currentTarget && setMax(maximized ? null : active)}>
        {node.tabs.map((p, i) => (
          <PanelTab key={p} panel={p} on={p === active} dragOver={tabDropIndex === i} closable={node.tabs.length > 1 || !!floatingId} onSelect={() => (floatingId ? null : layout.setActive(ws, node.id, p))} onClose={() => (floatingId ? layout.unfloat(ws, floatingId) : layout.closeTab(ws, p))} onDragStart={(e) => onTabDragStart(e, p)} onDragEnd={() => (dragPanel = null)} onDoubleClick={() => setMax(maximized ? null : p)} />
        ))}
        <div className="tab-menu">
          <MenuButton items={groupMenu} icon="more" label="Panel menu" className="ibtn" />
        </div>
      </div>
      <div ref={bodyRef} className="panel-body" onDragOver={onBodyDragOver} onDragLeave={() => setDropZone(null)} onDrop={onBodyDrop}>
        <PanelContent panel={active} />
        {dropZone ? <div className="panel-drop-hint" style={dropRect() ?? undefined} /> : null}
      </div>
    </div>
  );
}

function PanelTab({ panel, on, closable, dragOver, onSelect, onClose, onDragStart, onDragEnd, onDoubleClick }: { panel: PanelId; on: boolean; closable: boolean; dragOver: boolean; onSelect: () => void; onClose: () => void; onDragStart: (e: React.DragEvent) => void; onDragEnd: () => void; onDoubleClick: () => void }) {
  const sub = panelSubtitle(panel);
  return (
    <div role="tab" aria-selected={on} className={['panel-tab', on ? 'on' : '', dragOver ? 'drag-over' : ''].filter(Boolean).join(' ')} draggable onDragStart={onDragStart} onDragEnd={onDragEnd} onPointerDown={onSelect} onDoubleClick={onDoubleClick} title={PANEL_TITLES[panel]}>
      <Icon name="grip" size={10} className="grip" />
      <span className="tab-title">{PANEL_TITLES[panel]}</span>
      {sub ? <span className="tab-sub">{sub}</span> : null}
      {closable ? (
        <span
          className="tab-close"
          role="button"
          aria-label="Close panel"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
        >
          <Icon name="close" size={9} />
        </span>
      ) : null}
    </div>
  );
}

function FloatingPanel({ id, panel, x, y, w, h }: { id: string; panel: PanelId; x: number; y: number; w: number; h: number }) {
  const moveFloat = useLayout((s) => s.moveFloat);
  const start = useRef({ x, y, w, h });
  const onDragTitle = usePointerDrag({
    onStart: () => {
      start.current = { x, y, w, h };
    },
    onMove: (d) => moveFloat(id, { x: Math.max(0, start.current.x + d.dx), y: Math.max(0, start.current.y + d.dy) }),
    cursorClass: 'dragging-grab',
  });
  const onResize = usePointerDrag({
    onStart: () => {
      start.current = { x, y, w, h };
    },
    onMove: (d) => moveFloat(id, { w: Math.max(240, start.current.w + d.dx), h: Math.max(160, start.current.h + d.dy) }),
  });
  return (
    <div style={{ position: 'absolute', left: x, top: y, width: w, height: h, zIndex: 40, boxShadow: 'var(--shadow-dialog)', display: 'flex', flexDirection: 'column' }}>
      <div style={{ height: 8, background: 'var(--c-panel-header)', cursor: 'grab', borderBottom: '1px solid var(--c-seam)' }} onPointerDown={onDragTitle} />
      <div style={{ flex: 1, minHeight: 0 }}>
        <PanelGroupView node={{ kind: 'group', id: 'float-' + id, tabs: [panel], active: panel }} floatingId={id} />
      </div>
      <div style={{ position: 'absolute', right: 0, bottom: 0, width: 14, height: 14, cursor: 'nwse-resize' }} onPointerDown={onResize} />
    </div>
  );
}

/** Keyboard: backtick toggles maximize of the focused panel. */
export function useMaximizeShortcut() {
  const setMax = useUI((s) => s.setMaximizedPanel);
  const onKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === '`' && !useUI.getState().textEditing) {
        const s = useUI.getState();
        setMax(s.maximizedPanel ? null : s.focusedPanel);
      }
    },
    [setMax],
  );
  useEffect(() => {
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onKey]);
}

export function PanelToolbarButton(props: React.ComponentProps<typeof IconButton>) {
  return <IconButton {...props} />;
}
