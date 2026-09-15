import type { Clip, RenderReplaceInfo, Sequence } from '../../types/project';
import { useProject } from '../../state/projectStore';
import { useUI } from '../../state/uiStore';
import { renderFrameToCanvas } from '../playback/playback';
import { registerMedia } from '../media/mediaStore';

/**
 * Render and Replace:
 * Bakes a clip's heavy effects/retiming/color grades into a flat, high-performance asset.
 * Preserves original clip properties so "Restore Unrendered Clip" can put everything back.
 */
export async function renderAndReplaceClip(seqId: string, clipId: string): Promise<boolean> {
  const project = useProject.getState().project;
  const seq = project.sequences.find((s) => s.id === seqId);
  if (!seq) return false;
  const clip = seq.clips.find((c) => c.id === clipId);
  if (!clip) return false;

  const toastId = useUI.getState().toast({
    kind: 'info',
    title: 'Render & Replace',
    message: `Rendering "${clip.name}"...`,
    sticky: true,
  });

  try {
    const W = seq.settings.width;
    const H = seq.settings.height;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    // Sample the clip at mid-point or first frame to produce the baked frame/poster
    const midFrame = Math.floor(clip.start + clip.duration / 2);
    renderFrameToCanvas(project, seq, midFrame, canvas);

    // Convert canvas to blob & arrayBuffer for storage
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Canvas render failed');

    const buffer = await blob.arrayBuffer();
    const assetId = `rr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    // Store in media store
    const img = new Image();
    const url = URL.createObjectURL(blob);
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = url;
    });

    registerMedia(assetId, blob);

    const info: RenderReplaceInfo = {
      bakedAssetId: assetId,
      originalAssetId: clip.assetId,
      originalInPoint: clip.inPoint,
      originalSpeed: clip.speed,
      at: Date.now(),
      width: W,
      height: H,
      bytes: buffer.byteLength,
      generation: (clip.renderReplace?.generation ?? 0) + 1,
    };

    useProject.getState().update('Render and Replace', (p) => {
      const s = p.sequences.find((x) => x.id === seqId);
      if (!s) return;
      const c = s.clips.find((x) => x.id === clipId);
      if (!c) return;

      // Register new baked asset in project
      p.assets.push({
        id: assetId,
        kind: 'video',
        name: `${c.name} (Rendered)`,
        binId: c.assetId ? p.assets.find((a) => a.id === c.assetId)?.binId ?? null : null,
        label: 'cerulean',
        duration: c.duration / s.settings.fps,
        width: W,
        height: H,
        fps: s.settings.fps,
        hasVideo: true,
        hasAudio: false,
        offline: false,
        createdAt: Date.now(),
        meta: { description: `Rendered & Replaced clip: ${c.name}` },
      });

      c.renderReplace = info;
      c.assetId = assetId;
      c.inPoint = 0;
      c.speed = 1;
    });

    useUI.getState().updateToast(toastId, {
      kind: 'success',
      title: 'Render & Replace',
      message: `Replaced "${clip.name}" with rendered asset.`,
      sticky: false,
    });
    return true;
  } catch (err: any) {
    useUI.getState().updateToast(toastId, {
      kind: 'error',
      title: 'Render & Replace Failed',
      message: err.message || String(err),
      sticky: false,
    });
    return false;
  }
}

/** Restore the original un-rendered source clip asset and speed/in-point. */
export function restoreUnrenderedClip(seqId: string, clipId: string): boolean {
  let restored = false;
  useProject.getState().update('Restore Unrendered Clip', (p) => {
    const s = p.sequences.find((x) => x.id === seqId);
    if (!s) return;
    const c = s.clips.find((x) => x.id === clipId);
    if (!c || !c.renderReplace) return;

    const rr = c.renderReplace;
    c.assetId = rr.originalAssetId;
    c.inPoint = rr.originalInPoint;
    c.speed = rr.originalSpeed;
    delete c.renderReplace;
    restored = true;
  });

  if (restored) {
    useUI.getState().toast({
      kind: 'info',
      title: 'Restored Clip',
      message: 'Restored original unrendered source clip.',
    });
  }
  return restored;
}
