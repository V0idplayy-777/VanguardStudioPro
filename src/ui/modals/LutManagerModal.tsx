import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useUI, toast, logEvent, type ModalRequest } from '../../state/uiStore';
import { useProject, useActiveSequence } from '../../state/projectStore';
import { usePlayback, renderFrameToCanvas, getCompositor } from '../../engine/playback/playback';
import { Modal, Button, IconButton, TextField, Slider, Empty } from '../controls';
import { Icon } from '../icons';
import { cmd } from '../../app/commands';
import { download, formatBytes } from '../../engine/util';
import type { Id } from '../../types/project';
import {
  INPUT_TRANSFORMS,
  addLut,
  applyLutToImageData,
  builtInLooks,
  deleteLut,
  getLut,
  listLuts,
  onLutChange,
  parseLutFile,
  renameLut,
  toCube,
  warmLutCache,
  type Lut3D,
  type LutMeta,
} from '../../engine/color/lut';

type P = { modal: ModalRequest; close: () => void };

/** A row in any of the three lists. */
interface Entry {
  id: string;
  title: string;
  /** Where it came from, shown as a secondary line. */
  sub: string;
  group: 'imported' | 'camera' | 'looks';
  /** Only imported LUTs can be renamed, exported or deleted. */
  editable: boolean;
  fileName?: string;
  bytes?: number;
}

const GROUP_LABEL: Record<Entry['group'], string> = {
  imported: 'Your imported LUT files',
  camera: 'Camera log conversions (built in)',
  looks: 'Built-in looks',
};

const GROUP_HINT: Record<Entry['group'], string> = {
  imported: 'Files you added. These are stored in this browser and survive a reload.',
  camera:
    'Flat, washed-out camera footage needs converting to normal colours before you grade it. Pick the one that matches how the clip was shot.',
  looks: 'Ready-made creative grades. Nothing to install.',
};

export function LutManagerModal({ modal, close }: P) {
  const project = useProject((s) => s.project);
  const seq = useActiveSequence();
  const selection = useUI((s) => s.selection.clipIds);
  const frameVersion = usePlayback((s) => s.frameVersion);

  const [entries, setEntries] = useState<Entry[]>([]);
  const [selected, setSelected] = useState<string | null>((modal.payload?.lutId as string) ?? 'builtin:neutral');
  const [lut, setLut] = useState<Lut3D | null>(null);
  const [intensity, setIntensity] = useState(100);
  const [busy, setBusy] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [wipe, setWipe] = useState(0.5);
  const [dragOver, setDragOver] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);
  const srcCanvas = useRef<HTMLCanvasElement | null>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  /** Ungraded ImageData of the current program frame, reused across LUT switches. */
  const sourceRef = useRef<ImageData | null>(null);

  const selectedClips = useMemo(() => {
    if (!seq) return [];
    return seq.clips.filter((c) => selection.includes(c.id) && seq.tracks.find((t) => t.id === c.trackId)?.kind === 'video');
  }, [seq, selection]);

  /* ---------- list ---------- */
  const reload = useCallback(async () => {
    const imported = await listLuts();
    const transforms = INPUT_TRANSFORMS.filter((t) => t.id !== 'none' && t.id !== 'genericLog').map<Entry>((t) => ({
      id: `transform:${t.id}`,
      title: t.label,
      sub: t.note,
      group: 'camera',
      editable: false,
    }));
    const looks = builtInLooks().map<Entry>((l) => ({ id: l.id, title: l.title, sub: 'Built-in creative grade', group: 'looks', editable: false }));
    setEntries([
      ...imported.map<Entry>((m: LutMeta) => ({
        id: m.id,
        title: m.title,
        sub: `${m.size}\u00B3 cube${m.fileName ? ` \u00B7 ${m.fileName}` : ''}${m.bytes ? ` \u00B7 ${formatBytes(m.bytes)}` : ''}`,
        group: 'imported',
        editable: true,
        fileName: m.fileName,
        bytes: m.bytes,
      })),
      ...transforms,
      ...looks,
    ]);
  }, []);

  useEffect(() => {
    void (async () => {
      await warmLutCache();
      await reload();
    })();
    return onLutChange(() => void reload());
  }, [reload]);

  /* ---------- load the selected LUT ---------- */
  useEffect(() => {
    let dead = false;
    if (!selected) {
      setLut(null);
      return;
    }
    setBusy(selected);
    void getLut(selected)
      .then((l) => {
        if (!dead) setLut(l);
      })
      .catch(() => {
        if (!dead) setLut(null);
      })
      .finally(() => {
        if (!dead) setBusy(null);
      });
    return () => {
      dead = true;
    };
  }, [selected, entries.length]);

  /* ---------- grab the current program frame once ---------- */
  useEffect(() => {
    if (!seq) return;
    let dead = false;
    const playhead = usePlayback.getState().playhead;
    const cv = srcCanvas.current ?? document.createElement('canvas');
    srcCanvas.current = cv;
    void renderFrameToCanvas(project, seq, playhead, cv, { scale: 3 })
      .then(() => {
        if (dead || !cv.width || !cv.height) return;
        const ctx = cv.getContext('2d', { willReadFrequently: true });
        if (!ctx) return;
        sourceRef.current = ctx.getImageData(0, 0, cv.width, cv.height);
        drawPreview();
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
    // frameVersion is intentionally not a dependency: re-rendering the source
    // frame on every playhead tick would make the manager unusable during
    // playback. The preview is a still of wherever the playhead was on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seq?.id, project]);
  void frameVersion;

  /* ---------- paint the before/after wipe ---------- */
  const drawPreview = useCallback(() => {
    const out = previewRef.current;
    const src = sourceRef.current;
    if (!out || !src) return;
    if (out.width !== src.width || out.height !== src.height) {
      out.width = src.width;
      out.height = src.height;
    }
    const ctx = out.getContext('2d');
    if (!ctx) return;
    const graded = new ImageData(new Uint8ClampedArray(src.data), src.width, src.height);
    if (lut && intensity > 0) {
      try {
        applyLutToImageData(graded, lut, intensity / 100);
      } catch {
        /* an unreadable cube just previews as the original */
      }
    }
    const w = src.width;
    const split = Math.round(w * Math.max(0, Math.min(1, wipe)));
    // Left of the wipe is the graded result, right is the original, so dragging
    // right reveals more of what you started with. ImageData is a flat row-major
    // buffer, so a column range has to be copied one row at a time.
    ctx.putImageData(graded, 0, 0);
    if (split < w) {
      const o = ctx.createImageData(w - split, src.height);
      for (let y = 0; y < src.height; y++) {
        const rowStart = y * src.width * 4 + split * 4;
        o.data.set(src.data.subarray(rowStart, rowStart + (w - split) * 4), y * (w - split) * 4);
      }
      ctx.putImageData(o, split, 0);
    }
    // Wipe handle
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillRect(split - 1, 0, 2, src.height);
    ctx.font = `${Math.max(9, Math.round(src.height / 18))}px system-ui, sans-serif`;
    ctx.textBaseline = 'top';
    const pad = 4;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    const labelL = lut ? lut.title : 'No LUT';
    const lw = ctx.measureText(labelL).width + pad * 2;
    if (split > lw + 2) ctx.fillRect(pad, pad, lw, Math.round(src.height / 18) + pad);
    ctx.fillStyle = '#fff';
    if (split > lw + 2) ctx.fillText(labelL, pad * 2, pad * 1.5);
    const labelR = 'Original';
    const rw = ctx.measureText(labelR).width + pad * 2;
    if (w - split > rw + 2) {
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(w - rw - pad, pad, rw, Math.round(src.height / 18) + pad);
      ctx.fillStyle = '#fff';
      ctx.fillText(labelR, w - rw, pad * 1.5);
    }
  }, [lut, intensity, wipe]);

  useEffect(() => {
    drawPreview();
  }, [drawPreview, entries.length]);

  /* ---------- import ---------- */
  const importFiles = useCallback(
    async (files: File[]) => {
      const luts = files.filter((f) => /\.(cube|3dl)$/i.test(f.name));
      if (!luts.length) {
        toast('error', 'No LUT files found', 'LUT files end in .cube or .3dl.');
        return;
      }
      let added = 0;
      const failed: string[] = [];
      for (const f of luts) {
        try {
          const text = await f.text();
          const parsed = parseLutFile({ name: f.name, text });
          await addLut(parsed);
          added++;
          setSelected(parsed.id);
        } catch (err) {
          failed.push(`${f.name}: ${err instanceof Error ? err.message : 'unreadable'}`);
        }
      }
      if (added) {
        toast('success', `Imported ${added} LUT${added === 1 ? '' : 's'}`, 'They are now in the list and saved in this browser.');
        logEvent('info', `Imported ${added} LUT file(s)`, luts.map((f) => f.name).join(', '));
        await reload();
      }
      if (failed.length) toast('error', `Could not import ${failed.length} file(s)`, failed.join('\n'));
    },
    [reload],
  );

  const pick = () => fileRef.current?.click();

  const onFiles = async (list: FileList | null) => {
    if (!list || !list.length) return;
    await importFiles(Array.from(list));
  };

  /* ---------- per-entry actions ---------- */
  const doRename = async () => {
    if (!renaming) return;
    const title = renaming.value.trim();
    if (title) {
      await renameLut(renaming.id, title);
      await reload();
    }
    setRenaming(null);
  };

  const doExport = async (e: Entry) => {
    const l = await getLut(e.id);
    if (!l) {
      toast('error', 'Cannot export', 'That LUT could not be loaded.');
      return;
    }
    download(new Blob([toCube(l)], { type: 'text/plain' }), `${l.title.replace(/[^\w\-. ]+/g, '_')}.cube`);
    logEvent('info', `Exported LUT "${l.title}"`);
  };

  const doDelete = async (e: Entry) => {
    const ok = window.confirm(`Delete "${e.title}"?\n\nClips already using it will fall back to no grade until you pick another.`);
    if (!ok) return;
    await deleteLut(e.id);
    if (selected === e.id) setSelected('builtin:neutral');
    await reload();
    // Drop uploaded volumes so a re-import cannot be served a stale texture.
    getCompositor().invalidateLuts();
    toast('success', 'LUT deleted', e.title);
  };

  const apply = () => {
    if (!selected) return;
    const entry = entries.find((x) => x.id === selected);
    cmd.applyLutToClips(
      selectedClips.map((c) => c.id),
      selected,
      entry?.title ?? 'LUT',
    );
  };

  const groups: Entry['group'][] = ['imported', 'camera', 'looks'];

  return (
    <Modal
      title="Colour LUT Manager"
      icon="lut"
      onClose={close}
      width={880}
      footer={
        <>
          <span className="dim" style={{ fontSize: 11 }}>
            {selectedClips.length ? `${selectedClips.length} video clip(s) selected` : 'Select clips in the timeline to apply a LUT to them'}
          </span>
          <div className="spacer" />
          <Button icon="import" onClick={pick}>
            Import LUT file...
          </Button>
          <Button primary icon="ok" onClick={apply} disabled={!selectedClips.length || !selected}>
            Apply to selected clip{selectedClips.length === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      <input
        ref={fileRef}
        type="file"
        accept=".cube,.3dl"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          void onFiles(e.target.files);
          e.target.value = '';
        }}
      />
      <div
        style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          void onFiles(e.dataTransfer.files);
        }}
      >
        {/* left: preview */}
        <div style={{ flex: '0 0 380px' }}>
          <div
            style={{
              border: `1px dashed ${dragOver ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: 6,
              overflow: 'hidden',
              background: '#000',
              position: 'relative',
            }}
          >
            {sourceRef.current ? (
              <canvas
                ref={previewRef}
                style={{ display: 'block', width: '100%', cursor: 'ew-resize' }}
                onPointerDown={(e) => {
                  const el = e.currentTarget;
                  el.setPointerCapture(e.pointerId);
                  const move = (ev: PointerEvent) => {
                    const r = el.getBoundingClientRect();
                    setWipe(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)));
                  };
                  const up = () => {
                    window.removeEventListener('pointermove', move);
                    window.removeEventListener('pointerup', up);
                  };
                  window.addEventListener('pointermove', move);
                  window.addEventListener('pointerup', up);
                  const r = el.getBoundingClientRect();
                  setWipe(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
                }}
              />
            ) : (
              <div style={{ height: 214, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span className="dim" style={{ fontSize: 11 }}>
                  No frame to preview
                </span>
              </div>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
            <span className="dim" style={{ fontSize: 10, flex: '0 0 auto' }}>
              Wipe
            </span>
            <Slider value={wipe} min={0} max={1} step={0.005} onChange={(v) => setWipe(v)} title="Drag to compare the graded image with the original" />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
            <span className="dim" style={{ fontSize: 10, flex: '0 0 52px' }}>
              Strength
            </span>
            <Slider value={intensity} min={0} max={100} step={1} onChange={(v) => setIntensity(v)} title="How much of the LUT to apply" />
            <span className="dim" style={{ fontSize: 10, flex: '0 0 30px', textAlign: 'right' }}>
              {Math.round(intensity)}%
            </span>
          </div>
          <p className="dim" style={{ fontSize: 11, lineHeight: 1.5, marginTop: 10 }}>
            A <b>LUT</b> is a colour transform stored in a file. Camera manufacturers ship them to turn flat,
            washed-out &ldquo;log&rdquo; footage back into normal colours, and colourists ship them as creative looks.
            Drop a <code>.cube</code> or <code>.3dl</code> file anywhere in this window to add it.
          </p>
          <p className="dim" style={{ fontSize: 11, lineHeight: 1.5 }}>
            The preview is a still of the frame the playhead was on when this window opened.
          </p>
        </div>

        {/* right: lists */}
        <div style={{ flex: 1, minWidth: 0, maxHeight: 'min(560px, 62vh)', overflowY: 'auto' }}>
          {groups.map((g) => {
            const items = entries.filter((e) => e.group === g);
            if (!items.length && g === 'imported') {
              return (
                <div key={g} style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4 }}>{GROUP_LABEL[g]}</div>
                  <Empty icon="lut" title="No LUT files imported yet">
                    <div style={{ fontSize: 11 }}>
                      Drop <code>.cube</code> or <code>.3dl</code> files here, or use Import LUT file below.
                    </div>
                  </Empty>
                </div>
              );
            }
            if (!items.length) return null;
            return (
              <div key={g} style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 2 }}>{GROUP_LABEL[g]}</div>
                <div className="dim" style={{ fontSize: 10, marginBottom: 6, lineHeight: 1.45 }}>
                  {GROUP_HINT[g]}
                </div>
                {items.map((e) => {
                  const active = selected === e.id;
                  return (
                    <div
                      key={e.id}
                      onClick={() => setSelected(e.id)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '4px 6px',
                        borderRadius: 4,
                        cursor: 'pointer',
                        background: active ? 'var(--accent-dim, rgba(80,140,255,0.18))' : 'transparent',
                        border: `1px solid ${active ? 'var(--accent)' : 'transparent'}`,
                        marginBottom: 2,
                      }}
                    >
                      <Icon name={active ? 'ok' : 'lut'} size={12} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        {renaming?.id === e.id ? (
                          <TextField
                            autoFocus
                            value={renaming.value}
                            onChange={(ev) => setRenaming({ id: e.id, value: ev.target.value })}
                            onKeyDown={(ev) => {
                              if (ev.key === 'Enter') void doRename();
                              if (ev.key === 'Escape') setRenaming(null);
                            }}
                            onBlur={() => void doRename()}
                            style={{ height: 20, fontSize: 11 }}
                          />
                        ) : (
                          <>
                            <div style={{ fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.title}</div>
                            <div className="dim" style={{ fontSize: 10, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {e.sub}
                            </div>
                          </>
                        )}
                      </div>
                      {busy === e.id ? <Icon name="resetParam" size={12} /> : null}
                      {e.editable && renaming?.id !== e.id ? (
                        <>
                          <IconButton icon="text" label="Rename" sm onClick={(ev) => { ev.stopPropagation(); setRenaming({ id: e.id, value: e.title }); }} />
                          <IconButton icon="export" label="Export as .cube" sm onClick={(ev) => { ev.stopPropagation(); void doExport(e); }} />
                          <IconButton icon="error" label="Delete" sm onClick={(ev) => { ev.stopPropagation(); void doDelete(e); }} />
                        </>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
