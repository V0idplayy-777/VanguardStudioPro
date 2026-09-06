import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon, type IconName } from './icons';
import { clamp } from '../engine/util';
import { formatTime, parseTime, type TimecodeMode } from '../engine/timecode';
import { useUI, type ContextMenuItem } from '../state/uiStore';

/* ---------- basic buttons ---------- */

export function Button({ children, primary, danger, ghost, sm, icon, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean; danger?: boolean; ghost?: boolean; sm?: boolean; icon?: IconName }) {
  const cls = ['btn', primary ? 'primary' : '', danger ? 'danger' : '', ghost ? 'ghost' : '', sm ? 'sm' : '', rest.className ?? ''].filter(Boolean).join(' ');
  return (
    <button type="button" {...rest} className={cls}>
      {icon ? <Icon name={icon} size={12} /> : null}
      {children}
    </button>
  );
}

export function IconButton({ icon, on, tool, size, sm, lg, noline, label, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; on?: boolean; tool?: boolean; size?: number; sm?: boolean; lg?: boolean; noline?: boolean; label: string }) {
  const cls = ['ibtn', on ? 'on' : '', tool ? 'tool' : '', sm ? 'sm' : '', lg ? 'lg' : '', noline ? 'noline' : '', rest.className ?? ''].filter(Boolean).join(' ');
  return (
    <button type="button" aria-label={label} title={rest.title ?? label} aria-pressed={on} {...rest} className={cls}>
      <Icon name={icon} size={size} />
    </button>
  );
}

/* ---------- text editing focus guard ---------- */

export function useTextFocusGuard() {
  const setTextEditing = useUI((s) => s.setTextEditing);
  return {
    onFocus: () => setTextEditing(true),
    onBlur: () => setTextEditing(false),
  };
}

export function TextField(props: React.InputHTMLAttributes<HTMLInputElement> & { icon?: IconName }) {
  const guard = useTextFocusGuard();
  const { icon, className, ...rest } = props;
  const input = (
    <input
      type="text"
      spellCheck={false}
      {...rest}
      className={`field ${className ?? ''}`}
      onFocus={(e) => {
        guard.onFocus();
        rest.onFocus?.(e);
      }}
      onBlur={(e) => {
        guard.onBlur();
        rest.onBlur?.(e);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        rest.onKeyDown?.(e);
      }}
    />
  );
  if (!icon) return input;
  return (
    <div className="field-with-icon" style={{ flex: 1, minWidth: 0 }}>
      <Icon name={icon} size={12} />
      {input}
    </div>
  );
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const guard = useTextFocusGuard();
  return (
    <textarea
      spellCheck={false}
      {...props}
      className={`field ${props.className ?? ''}`}
      onFocus={(e) => {
        guard.onFocus();
        props.onFocus?.(e);
      }}
      onBlur={(e) => {
        guard.onBlur();
        props.onBlur?.(e);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        props.onKeyDown?.(e);
      }}
    />
  );
}

export function Select<T extends string | number>({ value, options, onChange, className, style, disabled, title }: { value: T; options: { value: T; label: string; group?: string }[]; onChange: (v: T) => void; className?: string; style?: React.CSSProperties; disabled?: boolean; title?: string }) {
  const isNum = typeof value === 'number';
  const groups = new Map<string, { value: T; label: string }[]>();
  for (const o of options) {
    const g = o.group ?? '';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(o);
  }
  const render = (list: { value: T; label: string }[]) =>
    list.map((o) => (
      <option key={String(o.value)} value={String(o.value)}>
        {o.label}
      </option>
    ));
  return (
    <select className={`field ${className ?? ''}`} style={style} value={String(value)} disabled={disabled} title={title} onChange={(e) => onChange((isNum ? Number(e.target.value) : e.target.value) as T)} onKeyDown={(e) => e.stopPropagation()}>
      {[...groups.entries()].map(([g, list]) =>
        g ? (
          <optgroup key={g} label={g}>
            {render(list)}
          </optgroup>
        ) : (
          <React.Fragment key="_">{render(list)}</React.Fragment>
        ),
      )}
    </select>
  );
}

export function Checkbox({ checked, onChange, label, disabled, radio, title }: { checked: boolean; onChange: (v: boolean) => void; label?: React.ReactNode; disabled?: boolean; radio?: boolean; title?: string }) {
  return (
    <button type="button" role={radio ? 'radio' : 'checkbox'} aria-checked={checked} title={title} disabled={disabled} className={['check', radio ? 'radio' : '', checked ? 'on' : '', disabled ? 'disabled' : ''].filter(Boolean).join(' ')} onClick={() => !disabled && onChange(!checked)}>
      <span className="box">{checked && !radio ? <Icon name="check" size={9} style={{ strokeWidth: 2 }} /> : null}</span>
      {label ? <span>{label}</span> : null}
    </button>
  );
}

export function Segmented<T extends string | number>({ value, options, onChange, title }: { value: T; options: { value: T; label?: string; icon?: IconName; title?: string }[]; onChange: (v: T) => void; title?: string }) {
  return (
    <div className="seg" title={title} role="radiogroup">
      {options.map((o) => (
        <button key={String(o.value)} type="button" role="radio" aria-checked={o.value === value} title={o.title ?? o.label} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.icon ? <Icon name={o.icon} size={12} /> : null}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- drag helper ---------- */

export interface DragInfo {
  dx: number;
  dy: number;
  x: number;
  y: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  startX: number;
  startY: number;
}

/**
 * Pointer drag helper. Returns an onPointerDown handler. `onStart` may return false to cancel.
 * The document body gets a cursor class while dragging.
 */
export function usePointerDrag(handlers: { onStart?: (e: React.PointerEvent) => boolean | void; onMove: (d: DragInfo, e: PointerEvent) => void; onEnd?: (d: DragInfo, moved: boolean, e: PointerEvent) => void; cursorClass?: string; threshold?: number; button?: number }) {
  const ref = useRef(handlers);
  ref.current = handlers;
  return useCallback((e: React.PointerEvent) => {
    const h = ref.current;
    if (e.button !== (h.button ?? 0)) return;
    if (h.onStart?.(e) === false) return;
    e.preventDefault();
    const startX = e.clientX,
      startY = e.clientY;
    let moved = false;
    const thr = h.threshold ?? 2;
    const target = e.currentTarget as HTMLElement;
    try {
      target.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (h.cursorClass) document.body.classList.add(h.cursorClass);
    const info = (ev: PointerEvent): DragInfo => ({ dx: ev.clientX - startX, dy: ev.clientY - startY, x: ev.clientX, y: ev.clientY, shift: ev.shiftKey, alt: ev.altKey, ctrl: ev.ctrlKey || ev.metaKey, startX, startY });
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - startX) < thr && Math.abs(ev.clientY - startY) < thr) return;
      moved = true;
      ref.current.onMove(info(ev), ev);
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (h.cursorClass) document.body.classList.remove(h.cursorClass);
      try {
        target.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      ref.current.onEnd?.(info(ev), moved, ev);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }, []);
}

/* ---------- hot text (scrubbable number) ---------- */

export interface HotTextProps {
  value: number;
  onChange: (v: number, commit: boolean) => void;
  min?: number;
  max?: number;
  step?: number;
  /** pixels per step */
  sensitivity?: number;
  decimals?: number;
  unit?: string;
  format?: (v: number) => string;
  parse?: (s: string) => number | null;
  disabled?: boolean;
  dim?: boolean;
  width?: number;
  title?: string;
  onBeginDrag?: () => void;
  onEndDrag?: () => void;
}

export function HotText({ value, onChange, min = -Infinity, max = Infinity, step = 1, sensitivity = 1, decimals, unit, format, parse, disabled, dim, width, title, onBeginDrag, onEndDrag }: HotTextProps) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const startVal = useRef(value);
  const setTextEditing = useUI((s) => s.setTextEditing);
  const dec = decimals ?? (step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3);
  const fmt = format ?? ((v: number) => v.toFixed(dec) + (unit ?? ''));

  const onDown = usePointerDrag({
    onStart: () => {
      if (disabled || editing) return false;
      startVal.current = value;
      onBeginDrag?.();
    },
    onMove: (d) => {
      const speed = d.shift ? 10 : d.ctrl ? 0.1 : 1;
      const raw = startVal.current + (d.dx / sensitivity) * step * speed;
      const q = Math.round(raw / (step * (d.ctrl ? 0.1 : 1))) * (step * (d.ctrl ? 0.1 : 1));
      onChange(clamp(q, min, max), false);
    },
    onEnd: (_d, moved) => {
      if (!moved) {
        setText(String(Number(value.toFixed(Math.max(dec, 3)))));
        setEditing(true);
        setTextEditing(true);
      } else {
        onChange(clamp(value, min, max), true);
      }
      onEndDrag?.();
    },
    cursorClass: 'dragging-ew',
  });

  useLayoutEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = () => {
    setEditing(false);
    setTextEditing(false);
    const p = parse ? parse(text) : evalNumber(text);
    if (p != null && !Number.isNaN(p)) onChange(clamp(p, min, max), true);
  };

  if (editing) {
    return (
      <span className="hot editing" style={{ width }}>
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
              setEditing(false);
              setTextEditing(false);
            }
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault();
              const cur = evalNumber(text) ?? value;
              const nv = clamp(cur + (e.key === 'ArrowUp' ? step : -step) * (e.shiftKey ? 10 : 1), min, max);
              setText(String(Number(nv.toFixed(Math.max(dec, 3)))));
              onChange(nv, true);
            }
          }}
        />
      </span>
    );
  }
  return (
    <span className={['hot', dim ? 'dim' : '', disabled ? 'dim' : ''].filter(Boolean).join(' ')} style={{ width, opacity: disabled ? 0.5 : 1, cursor: disabled ? 'default' : undefined }} onPointerDown={onDown} title={title ?? 'Drag to scrub, click to type'}>
      {fmt(value)}
    </span>
  );
}

/** Evaluate simple arithmetic like "12+3" or "50%" */
export function evalNumber(s: string): number | null {
  const t = s.replace(/[^0-9+\-*/().% ]/g, '').replace(/%/g, '').trim();
  if (!t) return null;
  try {
    // eslint-disable-next-line no-new-func
    const v = Function(`"use strict";return (${t});`)();
    return typeof v === 'number' && isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/* ---------- slider ---------- */

export function Slider({ value, min, max, step = 0.01, onChange, onBegin, onEnd, vertical, zero, style, disabled, log, title }: { value: number; min: number; max: number; step?: number; onChange: (v: number, commit: boolean) => void; onBegin?: () => void; onEnd?: () => void; vertical?: boolean; zero?: number; style?: React.CSSProperties; disabled?: boolean; log?: boolean; title?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);
  const toT = (v: number) => {
    if (log && min > 0) return (Math.log(v) - Math.log(min)) / (Math.log(max) - Math.log(min));
    return (v - min) / (max - min);
  };
  const fromT = (t: number) => {
    let v = log && min > 0 ? Math.exp(Math.log(min) + t * (Math.log(max) - Math.log(min))) : min + t * (max - min);
    v = Math.round(v / step) * step;
    return clamp(v, min, max);
  };
  const pick = (clientX: number, clientY: number, fine: boolean) => {
    const r = ref.current!.getBoundingClientRect();
    let t = vertical ? 1 - (clientY - r.top) / r.height : (clientX - r.left) / r.width;
    t = clamp(t, 0, 1);
    if (fine) t = toT(value) + (t - toT(value)) * 0.2;
    return fromT(t);
  };
  const onDown = usePointerDrag({
    onStart: (e) => {
      if (disabled) return false;
      onBegin?.();
      setActive(true);
      onChange(pick(e.clientX, e.clientY, false), false);
    },
    onMove: (d) => onChange(pick(d.x, d.y, d.ctrl), false),
    onEnd: (d) => {
      setActive(false);
      onChange(pick(d.x, d.y, d.ctrl), true);
      onEnd?.();
    },
    threshold: 0,
  });
  const t = clamp(toT(value), 0, 1);
  const zt = zero != null ? clamp(toT(zero), 0, 1) : 0;
  const fillFrom = Math.min(t, zt),
    fillTo = Math.max(t, zt);
  return (
    <div
      ref={ref}
      className={['slider', vertical ? 'vertical' : '', active ? 'active' : ''].filter(Boolean).join(' ')}
      style={{ ...style, opacity: disabled ? 0.4 : 1 }}
      onPointerDown={onDown}
      title={title}
      role="slider"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      onDoubleClick={() => zero != null && onChange(zero, true)}
      onWheel={(e) => {
        if (disabled) return;
        e.preventDefault();
        const dir = e.deltaY < 0 ? 1 : -1;
        onChange(clamp(value + dir * step * (e.shiftKey ? 10 : 1), min, max), true);
      }}
    >
      <div className="track" />
      {vertical ? <div className="fill" style={{ bottom: `${fillFrom * 100}%`, top: `${(1 - fillTo) * 100}%` }} /> : <div className="fill" style={{ left: `${fillFrom * 100}%`, right: `${(1 - fillTo) * 100}%` }} />}
      {zero != null ? <div className="zero" style={vertical ? { bottom: `${zt * 100}%`, width: 7, height: 1 } : { left: `${zt * 100}%` }} /> : null}
      <div className="thumb" style={vertical ? { bottom: `calc(${t * 100}% - 4.5px)` } : { left: `${t * 100}%` }} />
    </div>
  );
}

/* ---------- timecode field ---------- */

export function TimecodeField({ frames, fps, dropFrame, onChange, muted, title, mode: modeProp, style }: { frames: number; fps: number; dropFrame?: boolean; onChange?: (f: number) => void; muted?: boolean; title?: string; mode?: TimecodeMode; style?: React.CSSProperties }) {
  const uiMode = useUI((s) => s.timecodeMode);
  const setMode = useUI((s) => s.setTimecodeMode);
  const mode = modeProp ?? uiMode;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  const setTextEditing = useUI((s) => s.setTextEditing);
  useLayoutEffect(() => {
    if (editing) {
      ref.current?.focus();
      ref.current?.select();
    }
  }, [editing]);
  const commit = () => {
    setEditing(false);
    setTextEditing(false);
    const f = parseTime(text, fps, mode, dropFrame);
    if (f != null && onChange) onChange(f);
  };
  const shown = formatTime(Math.max(0, frames), fps, mode, dropFrame);
  const dragStart = useRef(0);
  const onDown = usePointerDrag({
    onStart: () => {
      if (!onChange) return false;
      dragStart.current = frames;
    },
    onMove: (d) => onChange?.(Math.max(0, Math.round(dragStart.current + d.dx * (d.shift ? 10 : 1) * 0.5))),
    onEnd: (_d, moved) => {
      if (!moved && onChange) {
        setText(shown);
        setEditing(true);
        setTextEditing(true);
      }
    },
    cursorClass: 'dragging-ew',
  });
  const ctx = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const items: ContextMenuItem[] = (['timecode', 'frames', 'seconds', 'feet16', 'feet35'] as TimecodeMode[]).map((m) => ({
      label: { timecode: 'Timecode', frames: 'Frames', seconds: 'Seconds', feet16: 'Feet + Frames 16mm', feet35: 'Feet + Frames 35mm' }[m],
      checked: mode === m,
      onSelect: () => setMode(m),
    }));
    useUI.getState().openContextMenu(e.clientX, e.clientY, items);
  };
  if (editing)
    return (
      <span className="tc" style={style}>
        <input
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
              setEditing(false);
              setTextEditing(false);
            }
          }}
        />
      </span>
    );
  return (
    <span className={`tc ${muted ? 'muted' : ''}`} style={{ ...style, cursor: onChange ? 'ew-resize' : 'default' }} title={title ?? (onChange ? 'Drag to scrub, click to type. Right-click for display format.' : undefined)} onPointerDown={onChange ? onDown : undefined} onContextMenu={ctx}>
      {shown}
    </span>
  );
}

/* ---------- color chip ---------- */

export function ColorChip({ color, onChange, alpha, onAlpha, title }: { color: string; onChange: (hex: string, commit: boolean) => void; alpha?: number; onAlpha?: (a: number) => void; title?: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span className="color-chip" title={title ?? color} style={{ background: color }}>
        <input type="color" value={toHex6(color)} onChange={(e) => onChange(e.target.value, false)} onBlur={(e) => onChange(e.target.value, true)} />
      </span>
      {alpha != null && onAlpha ? <HotText value={alpha * 100} min={0} max={100} step={1} unit="%" onChange={(v) => onAlpha(v / 100)} width={44} /> : null}
    </span>
  );
}

export function toHex6(c: string): string {
  if (/^#[0-9a-f]{6}$/i.test(c)) return c;
  if (/^#[0-9a-f]{3}$/i.test(c)) return '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3];
  if (/^#[0-9a-f]{8}$/i.test(c)) return c.slice(0, 7);
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const [r, g, b] = m[1].split(',').map((x) => parseFloat(x));
    return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  }
  return '#000000';
}

/* ---------- section ---------- */

export function Section({ title, open, onToggle, children, right, disabled, indent, icon }: { title: React.ReactNode; open: boolean; onToggle: () => void; children?: React.ReactNode; right?: React.ReactNode; disabled?: boolean; indent?: number; icon?: IconName }) {
  return (
    <div className={`section ${disabled ? 'disabled' : ''}`}>
      <div className="section-head" style={{ paddingLeft: 4 + (indent ?? 0) * 12 }} onClick={onToggle}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={11} style={{ color: 'var(--c-text-dim)' }} />
        {icon ? <Icon name={icon} size={12} style={{ color: 'var(--c-text-dim)' }} /> : null}
        <span className="title">{title}</span>
        <span onClick={(e) => e.stopPropagation()} style={{ display: 'inline-flex', gap: 2, alignItems: 'center' }}>
          {right}
        </span>
      </div>
      {open ? <div className="section-body">{children}</div> : null}
    </div>
  );
}

/* ---------- menus ---------- */

export function MenuList({ items, x, y, onClose, dense, anchorRight }: { items: ContextMenuItem[]; x: number; y: number; onClose: () => void; dense?: boolean; anchorRight?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [sub, setSub] = useState<{ index: number; x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let nx = anchorRight ? x - r.width : x;
    let ny = y;
    if (nx + r.width > window.innerWidth - 4) nx = Math.max(4, window.innerWidth - r.width - 4);
    if (ny + r.height > window.innerHeight - 4) ny = Math.max(4, window.innerHeight - r.height - 4);
    setPos({ x: nx, y: ny });
  }, [x, y, anchorRight, items]);
  return (
    <div ref={ref} className={`menu ${dense ? 'dense' : ''}`} style={{ left: pos.x, top: pos.y }} role="menu" onContextMenu={(e) => e.preventDefault()}>
      {items.map((it, i) => {
        if (it.separator) return <div key={i} className="menu-sep" />;
        const hasSub = !!it.submenu?.length;
        return (
          <div
            key={i}
            role="menuitem"
            aria-disabled={it.disabled}
            className={['menu-item', it.disabled ? 'disabled' : '', it.danger ? 'danger' : '', sub?.index === i ? 'open' : ''].filter(Boolean).join(' ')}
            onMouseEnter={(e) => {
              if (hasSub) {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setSub({ index: i, x: r.right - 2, y: r.top - 5 });
              } else setSub(null);
            }}
            onClick={(e) => {
              e.stopPropagation();
              if (it.disabled || hasSub) return;
              it.onSelect?.();
              onClose();
            }}
          >
            {it.checked ? (
              <span className="mi-check">
                <Icon name="check" size={11} />
              </span>
            ) : null}
            <span className="mi-label">{it.label}</span>
            {it.shortcut ? <span className="mi-shortcut">{it.shortcut}</span> : null}
            {hasSub ? <Icon name="chevronRight" size={11} className="mi-arrow" /> : null}
          </div>
        );
      })}
      {sub && items[sub.index]?.submenu ? <MenuList items={items[sub.index].submenu!} x={sub.x} y={sub.y} onClose={onClose} dense={dense} /> : null}
    </div>
  );
}

export function ContextMenuHost() {
  const menu = useUI((s) => s.contextMenu);
  const close = useUI((s) => s.closeContextMenu);
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('.menu')) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', close);
    };
  }, [menu, close]);
  if (!menu) return null;
  return <MenuList items={menu.items} x={menu.x} y={menu.y} onClose={close} dense />;
}

/** Button that opens a dropdown menu below itself. */
export function MenuButton({ items, children, className, icon, label, title, dense = true, alignRight }: { items: ContextMenuItem[] | (() => ContextMenuItem[]); children?: React.ReactNode; className?: string; icon?: IconName; label?: string; title?: string; dense?: boolean; alignRight?: boolean }) {
  const [open, setOpen] = useState<{ x: number; y: number } | null>(null);
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('.menu') || t === ref.current || ref.current?.contains(t)) return;
      setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(null);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);
  const list = typeof items === 'function' ? (open ? items() : []) : items;
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={className ?? 'ibtn'}
        title={title ?? label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={!!open}
        onClick={() => {
          if (open) return setOpen(null);
          const r = ref.current!.getBoundingClientRect();
          setOpen({ x: alignRight ? r.right : r.left, y: r.bottom + 2 });
        }}
      >
        {icon ? <Icon name={icon} /> : null}
        {children}
      </button>
      {open ? <MenuList items={list} x={open.x} y={open.y} onClose={() => setOpen(null)} dense={dense} anchorRight={alignRight} /> : null}
    </>
  );
}

/* ---------- modal ---------- */

export function Modal({ title, children, footer, onClose, width, icon }: { title: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode; onClose: () => void; width?: number | string; icon?: IconName }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width }} role="dialog" aria-modal="true" onKeyDown={(e) => e.stopPropagation()}>
        <div className="modal-title">
          {icon ? <Icon name={icon} size={14} style={{ color: 'var(--c-text-dim)' }} /> : null}
          <span className="title">{title}</span>
          <IconButton icon="close" label="Close" onClick={onClose} sm />
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

/* ---------- toasts ---------- */

export function ToastHost() {
  const toasts = useUI((s) => s.toasts);
  const dismiss = useUI((s) => s.dismissToast);
  if (!toasts.length) return null;
  const icon: Record<string, IconName> = { info: 'info', warning: 'warning', error: 'error', success: 'ok' };
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <Icon name={icon[t.kind]} size={14} style={{ marginTop: 1, color: t.kind === 'error' ? '#e08a83' : t.kind === 'warning' ? 'var(--c-warn)' : t.kind === 'success' ? 'var(--c-ok)' : 'var(--c-accent-text)' }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="t-title">{t.title}</div>
            {t.message ? <div className="t-msg">{t.message}</div> : null}
            {t.progress != null ? (
              <div className="t-progress">
                <div style={{ width: `${Math.round(t.progress * 100)}%` }} />
              </div>
            ) : null}
          </div>
          <IconButton icon="close" label="Dismiss" sm onClick={() => dismiss(t.id)} />
        </div>
      ))}
    </div>
  );
}

/* ---------- small helpers ---------- */

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd>{children}</kbd>;
}

export function Empty({ title, children, icon }: { title?: string; children?: React.ReactNode; icon?: IconName }) {
  return (
    <div className="empty">
      {icon ? <Icon name={icon} size={20} style={{ margin: '0 auto 8px', color: 'var(--c-text-faint)' }} /> : null}
      {title ? <strong>{title}</strong> : null}
      {children}
    </div>
  );
}

export function useLocalToggle(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [v, setV] = useState<boolean>(() => {
    try {
      const s = localStorage.getItem('vsp.' + key);
      return s == null ? initial : s === '1';
    } catch {
      return initial;
    }
  });
  return [
    v,
    (nv: boolean) => {
      setV(nv);
      try {
        localStorage.setItem('vsp.' + key, nv ? '1' : '0');
      } catch {
        /* ignore */
      }
    },
  ];
}

export function useElementSize<T extends HTMLElement>(): [React.RefObject<T | null>, { width: number; height: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setSize((s) => (s.width === r.width && s.height === r.height ? s : { width: r.width, height: r.height }));
    });
    ro.observe(el);
    setSize({ width: el.clientWidth, height: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}
