import type { GraphicAnimation, GraphicDocument, GraphicLayer, ShapeLayer, TextLayer, CaptionStyle } from '../../types/project';
import { evalNumber } from '../keyframes';
import { getMedia } from '../media/mediaStore';

/*
  Renders a GraphicDocument (titles / shapes / logos) to a 2D canvas at
  sequence resolution. Called by the compositor which uploads the result.
*/

function ease(type: GraphicAnimation['easing'], t: number) {
  switch (type) {
    case 'easeIn':
      return t * t * t;
    case 'easeOut':
      return 1 - Math.pow(1 - t, 3);
    case 'easeInOut':
      return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    case 'back': {
      const c1 = 1.70158,
        c3 = c1 + 1;
      return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    }
    default:
      return t;
  }
}

interface AnimState {
  alpha: number;
  dx: number;
  dy: number;
  scale: number;
  blur: number;
  reveal: number; // 0..1 for typewriter / wipe
}

function animState(layer: GraphicLayer, tSec: number, clipDurSec: number, w: number, h: number): AnimState {
  const s: AnimState = { alpha: 1, dx: 0, dy: 0, scale: 1, blur: 0, reveal: 1 };
  const apply = (a: GraphicAnimation | undefined, progress: number, out: boolean) => {
    if (!a || a.type === 'none') return;
    const p = out ? 1 - progress : progress; // p: 0 = hidden, 1 = shown
    const e = ease(a.easing, Math.min(1, Math.max(0, p)));
    switch (a.type) {
      case 'fade':
        s.alpha *= e;
        break;
      case 'slideLeft':
        s.dx += (1 - e) * w * 0.25;
        s.alpha *= e;
        break;
      case 'slideRight':
        s.dx -= (1 - e) * w * 0.25;
        s.alpha *= e;
        break;
      case 'slideUp':
        s.dy += (1 - e) * h * 0.2;
        s.alpha *= e;
        break;
      case 'slideDown':
        s.dy -= (1 - e) * h * 0.2;
        s.alpha *= e;
        break;
      case 'scale':
        s.scale *= 0.6 + 0.4 * e;
        s.alpha *= e;
        break;
      case 'typewriter':
      case 'wipe':
        s.reveal = Math.min(s.reveal, e);
        break;
      case 'blur':
        s.blur += (1 - e) * 24;
        s.alpha *= Math.min(1, e * 1.5);
        break;
    }
  };
  if (layer.animIn && layer.animIn.type !== 'none') {
    const start = layer.animIn.delay;
    const dur = Math.max(0.01, layer.animIn.duration);
    const p = tSec < start ? 0 : Math.min(1, (tSec - start) / dur);
    apply(layer.animIn, p, false);
  }
  if (layer.animOut && layer.animOut.type !== 'none') {
    const dur = Math.max(0.01, layer.animOut.duration);
    const end = clipDurSec - layer.animOut.delay;
    const start = end - dur;
    const p = tSec < start ? 0 : Math.min(1, (tSec - start) / dur);
    apply(layer.animOut, p, true);
  }
  return s;
}

function applyShadow(ctx: CanvasRenderingContext2D, layer: GraphicLayer) {
  if (layer.shadowEnabled) {
    ctx.shadowColor = withAlpha(layer.shadowColor, layer.shadowOpacity);
    ctx.shadowBlur = layer.shadowBlur;
    ctx.shadowOffsetX = layer.shadowOffsetX;
    ctx.shadowOffsetY = layer.shadowOffsetY;
  } else {
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  }
}

export function withAlpha(hex: string, alpha: number): string {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  const r = (n >> 16) & 255,
    g = (n >> 8) & 255,
    b = n & 255;
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha))})`;
}

export function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const paragraphs = text.split('\n');
  const lines: string[] = [];
  for (const para of paragraphs) {
    if (maxWidth <= 0) {
      lines.push(para);
      continue;
    }
    const words = para.split(' ');
    let cur = '';
    for (const w of words) {
      const test = cur ? cur + ' ' + w : w;
      if (ctx.measureText(test).width > maxWidth && cur) {
        lines.push(cur);
        cur = w;
      } else cur = test;
    }
    lines.push(cur);
  }
  return lines;
}

export function fontString(layer: Pick<TextLayer, 'fontFamily' | 'fontSize' | 'fontWeight' | 'italic'>) {
  return `${layer.italic ? 'italic ' : ''}${layer.fontWeight} ${layer.fontSize}px "${layer.fontFamily}", "Inter Variable", Inter, sans-serif`;
}

export function measureTextLayer(ctx: CanvasRenderingContext2D, layer: TextLayer): { width: number; height: number; lines: string[]; lineHeight: number } {
  ctx.font = fontString(layer);
  ctx.letterSpacing = `${layer.tracking}px`;
  const text = layer.allCaps ? layer.text.toUpperCase() : layer.text;
  const lines = wrapText(ctx, text, layer.boxWidth);
  const lineHeight = layer.fontSize * (layer.leading || 1.2);
  let width = 0;
  for (const l of lines) width = Math.max(width, ctx.measureText(l).width);
  return { width: layer.boxWidth > 0 ? layer.boxWidth : width, height: lines.length * lineHeight, lines, lineHeight };
}

export function layerBounds(ctx: CanvasRenderingContext2D, layer: GraphicLayer, frame: number): { x: number; y: number; w: number; h: number } {
  const x = evalNumber(layer.x, frame);
  const y = evalNumber(layer.y, frame);
  const sc = evalNumber(layer.scale, frame) / 100;
  if (layer.kind === 'text') {
    const m = measureTextLayer(ctx, layer);
    const pad = layer.background.enabled ? layer.background.padding : 0;
    const w = (m.width + pad * 2) * sc;
    const h = (m.height + pad * 2) * sc;
    if (layer.anchor === 'center') return { x: x - w / 2, y: y - h / 2, w, h };
    const ax = layer.align === 'center' ? x - w / 2 : layer.align === 'right' ? x - w : x;
    return { x: ax, y, w, h };
  }
  if (layer.kind === 'image') {
    const w = layer.width * sc,
      h = layer.height * sc;
    return layer.anchor === 'center' ? { x: x - w / 2, y: y - h / 2, w, h } : { x, y, w, h };
  }
  const sl = layer as ShapeLayer;
  if (sl.kind === 'line') {
    const x2 = x + sl.x2 * sc,
      y2 = y + sl.y2 * sc;
    return { x: Math.min(x, x2), y: Math.min(y, y2), w: Math.abs(x2 - x) || 2, h: Math.abs(y2 - y) || 2 };
  }
  const w = sl.width * sc,
    h = sl.height * sc;
  return layer.anchor === 'center' ? { x: x - w / 2, y: y - h / 2, w, h } : { x, y, w, h };
}

export function renderGraphic(ctx: CanvasRenderingContext2D, doc: GraphicDocument, frame: number, fps: number, clipDurationFrames: number, width: number, height: number, opts: { selectedIds?: string[] } = {}) {
  ctx.clearRect(0, 0, width, height);
  const tSec = frame / fps;
  const durSec = clipDurationFrames / fps;
  for (const layer of doc.layers) {
    if (!layer.visible) continue;
    const st = animState(layer, tSec, durSec, width, height);
    if (st.alpha <= 0.001) continue;
    const x = evalNumber(layer.x, frame) + st.dx;
    const y = evalNumber(layer.y, frame) + st.dy;
    const sc = (evalNumber(layer.scale, frame) / 100) * st.scale;
    const rot = (evalNumber(layer.rotation, frame) * Math.PI) / 180;
    const op = (evalNumber(layer.opacity, frame) / 100) * st.alpha;
    ctx.save();
    ctx.globalAlpha = op;
    ctx.globalCompositeOperation = layer.blend;
    if (st.blur > 0.5) ctx.filter = `blur(${st.blur.toFixed(1)}px)`;
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.scale(sc, sc);
    applyShadow(ctx, layer);
    if (layer.kind === 'text') drawText(ctx, layer, st);
    else if (layer.kind === 'image') drawImage(ctx, layer as any);
    else drawShape(ctx, layer as ShapeLayer, st);
    ctx.restore();
  }
}

function drawText(ctx: CanvasRenderingContext2D, layer: TextLayer, st: AnimState) {
  const m = measureTextLayer(ctx, layer);
  const pad = layer.background.enabled ? layer.background.padding : 0;
  const totalW = m.width + pad * 2;
  const totalH = m.height + pad * 2;
  // origin: for center anchor the box is centered on (0,0); else align determines x origin
  let ox: number, oy: number;
  if (layer.anchor === 'center') {
    ox = -totalW / 2;
    oy = -totalH / 2;
  } else {
    ox = layer.align === 'center' ? -totalW / 2 : layer.align === 'right' ? -totalW : 0;
    oy = 0;
  }
  if (layer.background.enabled) {
    ctx.save();
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = withAlpha(layer.background.color, layer.background.opacity);
    roundRect(ctx, ox, oy, totalW, totalH, layer.background.radius);
    ctx.fill();
    ctx.restore();
  }
  ctx.font = fontString(layer);
  ctx.letterSpacing = `${layer.tracking}px`;
  ctx.textBaseline = 'alphabetic';
  ctx.fontKerning = 'normal';
  const text = layer.allCaps ? layer.text.toUpperCase() : layer.text;
  void text;
  let totalChars = m.lines.reduce((a, l) => a + l.length, 0);
  const revealChars = layer.animIn?.type === 'typewriter' || layer.animOut?.type === 'typewriter' ? Math.floor(totalChars * st.reveal) : totalChars;
  const isWipe = (layer.animIn?.type === 'wipe' || layer.animOut?.type === 'wipe') && st.reveal < 1;
  if (isWipe) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(ox, oy - 1000, totalW * st.reveal, totalH + 2000);
    ctx.clip();
  }
  let drawn = 0;
  const ascent = layer.fontSize * 0.8;
  const startY = oy + pad + ascent + (m.lineHeight - layer.fontSize) / 2;
  const vOffset = layer.verticalAlign === 'middle' ? 0 : 0;
  m.lines.forEach((line, i) => {
    let seg = line;
    if (drawn + line.length > revealChars) seg = line.slice(0, Math.max(0, revealChars - drawn));
    drawn += line.length;
    if (!seg) return;
    const lw = ctx.measureText(line).width;
    let lx = ox + pad;
    if (layer.align === 'center') lx = ox + pad + (m.width - lw) / 2;
    else if (layer.align === 'right') lx = ox + pad + (m.width - lw);
    const ly = startY + i * m.lineHeight + vOffset;
    if (layer.strokeEnabled && layer.strokeWidth > 0) {
      ctx.lineJoin = 'round';
      ctx.lineWidth = layer.strokeWidth * 2;
      ctx.strokeStyle = layer.stroke;
      ctx.strokeText(seg, lx, ly);
    }
    if (layer.fillEnabled) {
      ctx.fillStyle = layer.fill;
      ctx.fillText(seg, lx, ly);
    }
    if (layer.underline) {
      const sw = ctx.measureText(seg).width;
      ctx.fillStyle = layer.fill;
      ctx.fillRect(lx, ly + layer.fontSize * 0.1, sw, Math.max(1, layer.fontSize * 0.06));
    }
  });
  if (isWipe) ctx.restore();
}

function drawShape(ctx: CanvasRenderingContext2D, layer: ShapeLayer, st: AnimState) {
  const w = layer.width,
    h = layer.height;
  const ox = layer.anchor === 'center' ? -w / 2 : 0;
  const oy = layer.anchor === 'center' ? -h / 2 : 0;
  ctx.beginPath();
  if (layer.kind === 'rect') roundRect(ctx, ox, oy, w * (layer.animIn?.type === 'wipe' ? st.reveal : 1), h, layer.radius);
  else if (layer.kind === 'ellipse') ctx.ellipse(ox + w / 2, oy + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  else if (layer.kind === 'line') {
    ctx.moveTo(0, 0);
    ctx.lineTo(layer.x2 * st.reveal, layer.y2 * st.reveal);
  } else {
    const n = Math.max(3, layer.sides);
    const r = Math.min(w, h) / 2;
    const cx = ox + w / 2,
      cy = oy + h / 2;
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
      const px = cx + Math.cos(a) * r,
        py = cy + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }
  if (layer.fillEnabled && layer.kind !== 'line') {
    ctx.fillStyle = layer.fill;
    ctx.fill();
  }
  if ((layer.strokeEnabled && layer.strokeWidth > 0) || layer.kind === 'line') {
    ctx.lineWidth = layer.kind === 'line' ? Math.max(1, layer.strokeWidth) : layer.strokeWidth;
    ctx.strokeStyle = layer.kind === 'line' && !layer.strokeEnabled ? layer.fill : layer.stroke;
    ctx.lineCap = 'round';
    ctx.stroke();
  }
}

function drawImage(ctx: CanvasRenderingContext2D, layer: { assetId: string; width: number; height: number; anchor: string }) {
  const rec = getMedia(layer.assetId);
  const img = rec?.image;
  if (!img) return;
  const ox = layer.anchor === 'center' ? -layer.width / 2 : 0;
  const oy = layer.anchor === 'center' ? -layer.height / 2 : 0;
  ctx.drawImage(img, ox, oy, layer.width, layer.height);
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  if (rr <= 0) {
    ctx.rect(x, y, w, h);
    return;
  }
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Draw a caption block with the given style. `localFrame`/`fps` (optional) drive entry animations. */
export function renderCaption(ctx: CanvasRenderingContext2D, text: string, style: CaptionStyle, width: number, height: number, localFrame = 0, fps = 30, captionWords?: { t0: number; t1: number; text: string }[], sequenceFrame = 0) {
  ctx.save();
  ctx.font = `${style.italic ? 'italic ' : ''}${style.fontWeight} ${style.fontSize}px "${style.fontFamily}", "Inter Variable", Inter, sans-serif`;
  ctx.letterSpacing = `${style.letterSpacing}px`;
  ctx.textBaseline = 'alphabetic';
  const maxW = width * style.maxWidth;

  // Tokenise into words, keeping the `*kicker*` markup and per-line breaks.
  const lines = tokenizeCaption(text, !!style.kicker);
  const wrapped = wrapWordLines(ctx, lines, maxW);

  // Entry animation progress 0..1 (a couple of frames).
  const anim = style.animation ?? 'none';
  const animFrames = anim === 'typewriter' ? Math.max(3, fps * 0.5) : Math.max(2, Math.round(fps * 0.12));
  const p = localFrame <= 0 || anim === 'none' ? 1 : Math.min(1, localFrame / animFrames);
  const easeOut = 1 - Math.pow(1 - p, 3);

  // Typewriter budget: total visible characters across the whole caption.
  const totalChars = wrapped.reduce((n, line) => n + line.reduce((m, w) => m + w.text.length + 1, 0), 0);
  const charBudget = anim === 'typewriter' ? Math.ceil(totalChars * p) : Infinity;
  let charsUsed = 0;
  let wordIndex = 0;

  const lh = style.fontSize * 1.25;
  const pad = style.fontSize * 0.3;
  const blockH = wrapped.length * lh + pad;
  const baseY = height * style.position - blockH;

  wrapped.forEach((words, i) => {
    const lineText = words.map((w) => w.text).join(' ');
    const lw = ctx.measureText(lineText).width;
    let lineX = (width - lw) / 2;
    if (style.align === 'left') lineX = (width - maxW) / 2;
    else if (style.align === 'right') lineX = (width + maxW) / 2 - lw;
    const lineY = baseY + pad + (i + 1) * lh - lh * 0.25;

    // Animation transforms around the line centre.
    let ax = 0,
      ay = 0,
      scale = 1,
      alpha = 1;
    if (anim === 'pop') {
      scale = 0.6 + 0.4 * easeOut;
      alpha = p;
    } else if (anim === 'scale') {
      scale = 0.85 + 0.15 * easeOut;
      alpha = p;
    } else if (anim === 'slideUp') {
      ay = (1 - easeOut) * style.fontSize * 0.7;
      alpha = p;
    } else if (anim === 'fade') {
      alpha = p;
    }
    const cx = lineX + lw / 2;
    const cy = lineY - style.fontSize * 0.35;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    ctx.translate(-cx, -cy);
    ctx.translate(0, ay);
    ctx.globalAlpha = alpha;

    if (style.backgroundOpacity > 0) {
      ctx.fillStyle = withAlpha(style.backgroundColor, style.backgroundOpacity);
      ctx.fillRect(lineX - pad * 0.6, lineY - style.fontSize * 0.95, lw + pad * 1.2, lh);
    }

    let x = lineX;
    for (const w of words) {
      if (anim === 'typewriter') {
        charsUsed += w.text.length;
        if (charsUsed > charBudget) break;
      }

      // Check for word-level karaoke active highlight
      const curWordInfo = captionWords && captionWords[wordIndex];
      const isKaraokeActive = style.karaoke && curWordInfo && sequenceFrame >= curWordInfo.t0 && sequenceFrame < curWordInfo.t1;
      const isWordSpoken = style.karaoke && curWordInfo && sequenceFrame >= curWordInfo.t1;

      const ww = ctx.measureText(w.text).width;
      if (style.edge === 'shadow') {
        ctx.shadowColor = style.edgeColor;
        ctx.shadowBlur = style.fontSize * 0.15;
        ctx.shadowOffsetX = style.fontSize * 0.04;
        ctx.shadowOffsetY = style.fontSize * 0.04;
      } else if (style.edge === 'outline' || style.edge === 'raised') {
        ctx.lineJoin = 'round';
        ctx.lineWidth = style.fontSize * (style.edge === 'raised' ? 0.06 : 0.12);
        ctx.strokeStyle = style.edgeColor;
        ctx.strokeText(w.text, x, lineY);
      }

      if (isKaraokeActive) {
        ctx.save();
        ctx.translate(x + ww / 2, lineY - style.fontSize * 0.35);
        ctx.scale(1.15, 1.15); // Active word pop
        ctx.translate(-(x + ww / 2), -(lineY - style.fontSize * 0.35));
        ctx.fillStyle = style.karaokeColor ?? '#ffd54a';
        ctx.fillText(w.text, x, lineY);
        ctx.restore();
      } else if (isWordSpoken) {
        ctx.fillStyle = style.karaokeColor ?? '#ffd54a';
        ctx.fillText(w.text, x, lineY);
      } else {
        ctx.fillStyle = w.kicker ? (style.kickerColor ?? '#ffd54a') : style.color;
        ctx.fillText(w.text, x, lineY);
      }

      ctx.shadowColor = 'transparent';
      x += ww + ctx.measureText(' ').width;
      charsUsed += 1; // the separating space
      wordIndex++;
    }
    ctx.restore();
  });
  ctx.restore();
}

interface CaptionWord {
  text: string;
  kicker: boolean;
}

/** Split caption text into words, honouring `*word*` kicker markup and hard line breaks. */
function tokenizeCaption(text: string, autoKicker: boolean): CaptionWord[][] {
  const raw = text.replace(/\r/g, '');
  let explicit = false;
  const out = raw.split('\n').map((line) =>
    line
      .split(/\s+/)
      .filter(Boolean)
      .map((tok) => {
        const m = tok.match(/^\*([^*]+)\*$/);
        if (m) {
          explicit = true;
          return { text: m[1], kicker: true };
        }
        return { text: tok.replace(/\*/g, ''), kicker: false };
      }),
  );
  if (!explicit && autoKicker) {
    for (let li = out.length - 1; li >= 0; li--) {
      if (out[li].length) {
        out[li][out[li].length - 1].kicker = true;
        break;
      }
    }
  }
  return out.filter((l) => l.length > 0);
}

/** Wrap tokenised lines of words to the maximum width. */
function wrapWordLines(ctx: CanvasRenderingContext2D, lines: CaptionWord[][], maxW: number): CaptionWord[][] {
  const spaceW = ctx.measureText(' ').width;
  const out: CaptionWord[][] = [];
  for (const line of lines) {
    let cur: CaptionWord[] = [];
    let curW = 0;
    for (const w of line) {
      const ww = ctx.measureText(w.text).width;
      const sep = cur.length ? spaceW : 0;
      if (cur.length && curW + sep + ww > maxW) {
        out.push(cur);
        cur = [w];
        curW = ww;
      } else {
        cur.push(w);
        curW += sep + ww;
      }
    }
    if (cur.length) out.push(cur);
  }
  return out;
}
