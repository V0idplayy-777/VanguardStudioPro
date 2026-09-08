import type { GraphicDocument, GraphicLayer, ShapeLayer, TextLayer, GraphicAnimation } from '../../types/project';
import { param } from '../../types/project';
import { uid } from '../../engine/util';
import { useGraphicsLibrary, libraryEntryAsTemplate } from './library';

/*
  Motion graphics templates. Each template builds a GraphicDocument sized to
  the sequence. Everything here is plain data: the renderer in
  engine/graphics/graphicRenderer.ts draws it and the Essential Graphics panel
  edits it, so there is nothing "baked" - every layer stays editable.
*/

export interface GraphicTemplate {
  id: string;
  name: string;
  category: 'Titles' | 'Lower Thirds' | 'Callouts' | 'Social' | 'Shapes' | 'Credits';
  description: string;
  build: (w: number, h: number) => GraphicDocument;
}

const anim = (type: GraphicAnimation['type'], duration = 0.5, delay = 0, easing: GraphicAnimation['easing'] = 'easeOut'): GraphicAnimation => ({ type, duration, delay, easing });

function base(kind: GraphicLayer['kind'], name: string, x: number, y: number): Omit<GraphicLayer, 'kind'> & { kind: any } {
  return {
    id: uid('gl'),
    kind,
    name,
    visible: true,
    locked: false,
    x: param(x),
    y: param(y),
    scale: param(100),
    rotation: param(0),
    opacity: param(100),
    anchor: 'topLeft',
    pin: 'none',
    fill: '#e0e0e0',
    fillEnabled: true,
    stroke: '#000000',
    strokeWidth: 0,
    strokeEnabled: false,
    shadowEnabled: false,
    shadowColor: '#000000',
    shadowBlur: 8,
    shadowOffsetX: 0,
    shadowOffsetY: 4,
    shadowOpacity: 0.6,
    blend: 'source-over',
  } as any;
}

export function textLayer(text: string, x: number, y: number, o: Partial<TextLayer> = {}): TextLayer {
  return {
    ...(base('text', o.name ?? (text.slice(0, 24) || 'Text'), x, y) as any),
    kind: 'text',
    text,
    fontFamily: 'Inter Variable',
    fontSize: 72,
    fontWeight: 460,
    italic: false,
    underline: false,
    allCaps: false,
    tracking: 0,
    leading: 1.15,
    align: 'left',
    verticalAlign: 'top',
    boxWidth: 0,
    boxHeight: 0,
    background: { enabled: false, color: '#000000', opacity: 0.6, padding: 16, radius: 0 },
    tabularNums: false,
    ...o,
  };
}

export function shapeLayer(kind: ShapeLayer['kind'], x: number, y: number, width: number, height: number, o: Partial<ShapeLayer> = {}): ShapeLayer {
  return {
    ...(base(kind, o.name ?? { rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line', polygon: 'Polygon' }[kind], x, y) as any),
    kind,
    width,
    height,
    radius: 0,
    sides: 5,
    x2: width,
    y2: 0,
    ...o,
  };
}

const doc = (layers: GraphicLayer[], templateId: string, introProtect = 0.6, outroProtect = 0.5): GraphicDocument => ({ layers, introProtect, outroProtect, templateId });

export const TEMPLATES: GraphicTemplate[] = [
  {
    id: 'title-basic',
    name: 'Title',
    category: 'Titles',
    description: 'A single centered title.',
    build: (w, h) => doc([textLayer('Title', w / 2, h / 2, { align: 'center', verticalAlign: 'middle', anchor: 'center', fontSize: Math.round(h * 0.09), fontWeight: 560, pin: 'center', animIn: anim('fade', 0.4), animOut: anim('fade', 0.3) })], 'title-basic'),
  },
  {
    id: 'title-subtitle',
    name: 'Title and Subtitle',
    category: 'Titles',
    description: 'Headline with a smaller line underneath and a rule between them.',
    build: (w, h) =>
      doc(
        [
          textLayer('HEADLINE', w / 2, h * 0.44, { name: 'Headline', align: 'center', anchor: 'center', fontSize: Math.round(h * 0.1), fontWeight: 620, tracking: 6, allCaps: true, pin: 'center', animIn: anim('slideUp', 0.5), animOut: anim('fade', 0.3) }),
          shapeLayer('rect', w / 2 - w * 0.06, h * 0.52, w * 0.12, Math.max(2, h * 0.004), { name: 'Rule', fill: '#3d7bd9', animIn: anim('wipe', 0.5, 0.1), animOut: anim('fade', 0.3) }),
          textLayer('Subtitle goes here', w / 2, h * 0.58, { name: 'Subtitle', align: 'center', anchor: 'center', fontSize: Math.round(h * 0.036), fontWeight: 380, fill: '#c5c5c5', pin: 'center', animIn: anim('fade', 0.5, 0.25), animOut: anim('fade', 0.3) }),
        ],
        'title-subtitle',
      ),
  },
  {
    id: 'lt-clean',
    name: 'Clean Lower Third',
    category: 'Lower Thirds',
    description: 'Name and role, left aligned, with an accent bar.',
    build: (w, h) =>
      doc(
        [
          shapeLayer('rect', w * 0.07, h * 0.76, Math.max(4, w * 0.004), h * 0.11, { name: 'Accent bar', fill: '#3d7bd9', animIn: anim('wipe', 0.35), animOut: anim('fade', 0.25) }),
          textLayer('Name Surname', w * 0.085, h * 0.76, { name: 'Name', fontSize: Math.round(h * 0.052), fontWeight: 560, pin: 'left', animIn: anim('slideLeft', 0.5, 0.1), animOut: anim('fade', 0.3) }),
          textLayer('Job title, Organisation', w * 0.085, h * 0.76 + h * 0.062, { name: 'Role', fontSize: Math.round(h * 0.03), fontWeight: 380, fill: '#c5c5c5', pin: 'left', animIn: anim('slideLeft', 0.5, 0.25), animOut: anim('fade', 0.3) }),
        ],
        'lt-clean',
      ),
  },
  {
    id: 'lt-boxed',
    name: 'Boxed Lower Third',
    category: 'Lower Thirds',
    description: 'Two stacked solid boxes; the top one takes the name.',
    build: (w, h) =>
      doc(
        [
          textLayer('NAME SURNAME', w * 0.07, h * 0.78, { name: 'Name', fontSize: Math.round(h * 0.046), fontWeight: 600, allCaps: true, tracking: 2, fill: '#101010', background: { enabled: true, color: '#e0e0e0', opacity: 1, padding: Math.round(h * 0.016), radius: 0 }, pin: 'left', animIn: anim('slideLeft', 0.4), animOut: anim('slideLeft', 0.3, 0, 'easeIn') }),
          textLayer('What they do', w * 0.07, h * 0.78 + h * 0.085, { name: 'Role', fontSize: Math.round(h * 0.03), fontWeight: 400, fill: '#e0e0e0', background: { enabled: true, color: '#3d7bd9', opacity: 1, padding: Math.round(h * 0.012), radius: 0 }, pin: 'left', animIn: anim('slideLeft', 0.4, 0.15), animOut: anim('slideLeft', 0.3, 0, 'easeIn') }),
        ],
        'lt-boxed',
      ),
  },
  {
    id: 'lt-minimal-line',
    name: 'Underlined Name',
    category: 'Lower Thirds',
    description: 'Name over a thin animated line.',
    build: (w, h) =>
      doc(
        [
          textLayer('Name Surname', w * 0.07, h * 0.8, { name: 'Name', fontSize: Math.round(h * 0.048), fontWeight: 500, pin: 'left', animIn: anim('typewriter', 0.8), animOut: anim('fade', 0.3) }),
          shapeLayer('rect', w * 0.07, h * 0.8 + h * 0.062, w * 0.26, Math.max(2, h * 0.003), { name: 'Line', fill: '#e0e0e0', animIn: anim('wipe', 0.6, 0.2), animOut: anim('fade', 0.3) }),
        ],
        'lt-minimal-line',
      ),
  },
  {
    id: 'callout-label',
    name: 'Callout Label',
    category: 'Callouts',
    description: 'Small pill label with a pointer line, for annotating on-screen items.',
    build: (w, h) =>
      doc(
        [
          shapeLayer('line', w * 0.55, h * 0.4, w * 0.08, h * 0.1, { name: 'Pointer', stroke: '#e0e0e0', strokeEnabled: true, strokeWidth: Math.max(2, h * 0.003), fillEnabled: false, x2: -w * 0.08, y2: h * 0.1, animIn: anim('wipe', 0.35), animOut: anim('fade', 0.2) }),
          textLayer('Label', w * 0.555, h * 0.375, { name: 'Label', fontSize: Math.round(h * 0.03), fontWeight: 500, fill: '#101010', background: { enabled: true, color: '#e0e0e0', opacity: 1, padding: Math.round(h * 0.012), radius: Math.round(h * 0.03) }, animIn: anim('scale', 0.35, 0.25, 'back'), animOut: anim('fade', 0.2) }),
        ],
        'callout-label',
      ),
  },
  {
    id: 'social-handle',
    name: 'Social Handle',
    category: 'Social',
    description: 'Compact handle chip pinned to the bottom-right corner.',
    build: (w, h) =>
      doc([textLayer('@yourhandle', w * 0.93, h * 0.9, { name: 'Handle', align: 'right', fontSize: Math.round(h * 0.03), fontWeight: 500, fill: '#e0e0e0', background: { enabled: true, color: '#000000', opacity: 0.55, padding: Math.round(h * 0.012), radius: 4 }, pin: 'right', animIn: anim('slideRight', 0.4), animOut: anim('fade', 0.3) })], 'social-handle'),
  },
  {
    id: 'social-subscribe',
    name: 'Call to Action',
    category: 'Social',
    description: 'A short action prompt in a bold box, bottom center.',
    build: (w, h) =>
      doc(
        [
          shapeLayer('rect', w / 2 - w * 0.13, h * 0.84, w * 0.26, h * 0.08, { name: 'Box', fill: '#c9463d', radius: 4, animIn: anim('scale', 0.35, 0, 'back'), animOut: anim('scale', 0.25, 0, 'easeIn') }),
          textLayer('SUBSCRIBE', w / 2, h * 0.88, { name: 'Text', align: 'center', anchor: 'center', verticalAlign: 'middle', fontSize: Math.round(h * 0.04), fontWeight: 700, tracking: 4, allCaps: true, pin: 'center', animIn: anim('fade', 0.3, 0.15), animOut: anim('fade', 0.2) }),
        ],
        'social-subscribe',
      ),
  },
  {
    id: 'shape-vignette-bar',
    name: 'Letterbox Bars',
    category: 'Shapes',
    description: 'Top and bottom black bars for a 2.39:1 look.',
    build: (w, h) => {
      const bar = (h - w / 2.39) / 2;
      return doc(
        [
          shapeLayer('rect', 0, 0, w, bar, { name: 'Top bar', fill: '#000000', pin: 'top' }),
          shapeLayer('rect', 0, h - bar, w, bar, { name: 'Bottom bar', fill: '#000000', pin: 'bottom' }),
        ],
        'shape-vignette-bar',
        0,
        0,
      );
    },
  },
  {
    id: 'shape-solid',
    name: 'Solid Panel',
    category: 'Shapes',
    description: 'Semi-transparent panel for backing text.',
    build: (w, h) => doc([shapeLayer('rect', w * 0.06, h * 0.06, w * 0.4, h * 0.3, { name: 'Panel', fill: '#000000', opacity: param(65), radius: 6 })], 'shape-solid', 0, 0),
  },
  {
    id: 'credits-roll',
    name: 'Rolling Credits',
    category: 'Credits',
    description: 'Two-column credits that roll from bottom to top over the clip duration.',
    build: (w, h) => {
      const lines = ['Director\tYour Name', 'Producer\tYour Name', 'Editor\tYour Name', 'Camera\tYour Name', 'Sound\tYour Name', 'Music\tYour Name', 'Colour\tYour Name', 'Thanks\tEveryone'];
      const roll = textLayer(lines.map((l) => l.split('\t').join('      ')).join('\n'), w / 2, h, { name: 'Credits', align: 'center', anchor: 'center', fontSize: Math.round(h * 0.036), fontWeight: 400, leading: 1.8, tabularNums: true, pin: 'center' });
      // Keyframed vertical motion: the Essential Graphics panel exposes these keyframes.
      roll.y = { value: h, animated: true, keyframes: [{ t: 0, v: h + h * 0.4, interp: 'linear' }, { t: 300, v: -h * 0.6, interp: 'linear' }] } as any;
      return doc([roll], 'credits-roll', 0, 0);
    },
  },
  {
    id: 'timer',
    name: 'Corner Timer',
    category: 'Callouts',
    description: 'A tabular-figure counter in the top-left corner; edit the text or animate it.',
    build: (w, h) => doc([textLayer('00:00', w * 0.05, h * 0.06, { name: 'Timer', fontSize: Math.round(h * 0.05), fontWeight: 460, tabularNums: true, fill: '#e0e0e0', background: { enabled: true, color: '#000000', opacity: 0.5, padding: Math.round(h * 0.01), radius: 2 }, pin: 'left' })], 'timer', 0, 0),
  },
  {
    id: 'title-cinematic',
    name: 'Cinematic Opener',
    category: 'Titles',
    description: 'Tracked eyebrow, huge title and twin rules. A classic film opening.',
    build: (w, h) =>
      doc(
        [
          shapeLayer('rect', w / 2 - w * 0.16, h * 0.335, w * 0.32, Math.max(2, h * 0.003), { name: 'Rule top', fill: '#e0e0e0', animIn: anim('wipe', 0.6), animOut: anim('fade', 0.3) }),
          textLayer('A VANGUARD PRODUCTION', w / 2, h * 0.375, { name: 'Eyebrow', align: 'center', anchor: 'center', fontSize: Math.round(h * 0.026), fontWeight: 500, tracking: Math.round(h * 0.012), allCaps: true, fill: '#c5c5c5', pin: 'center', animIn: anim('fade', 0.5, 0.3), animOut: anim('fade', 0.3) }),
          textLayer('THE TITLE', w / 2, h * 0.5, { name: 'Title', align: 'center', anchor: 'center', verticalAlign: 'middle', fontSize: Math.round(h * 0.14), fontWeight: 680, tracking: Math.round(h * 0.006), allCaps: true, pin: 'center', animIn: anim('slideUp', 0.7, 0.4), animOut: anim('fade', 0.3) }),
          shapeLayer('rect', w / 2 - w * 0.16, h * 0.645, w * 0.32, Math.max(2, h * 0.003), { name: 'Rule bottom', fill: '#e0e0e0', animIn: anim('wipe', 0.6, 0.2), animOut: anim('fade', 0.3) }),
        ],
        'title-cinematic',
      ),
  },
  {
    id: 'title-quote',
    name: 'Quote Card',
    category: 'Titles',
    description: 'Oversized quotation mark with a centered quote and attribution.',
    build: (w, h) =>
      doc(
        [
          textLayer('“', w / 2, h * 0.3, { name: 'Mark', align: 'center', anchor: 'center', fontSize: Math.round(h * 0.22), fontWeight: 700, fill: '#3d7bd9', pin: 'center', animIn: anim('scale', 0.5, 0, 'back'), animOut: anim('fade', 0.3) }),
          textLayer('Great stories are told\none frame at a time.', w / 2, h * 0.52, { name: 'Quote', align: 'center', anchor: 'center', verticalAlign: 'middle', fontSize: Math.round(h * 0.055), fontWeight: 460, italic: true, leading: 1.35, pin: 'center', animIn: anim('fade', 0.6, 0.25), animOut: anim('fade', 0.3) }),
          textLayer('— YOUR NAME', w / 2, h * 0.72, { name: 'Attribution', align: 'center', anchor: 'center', fontSize: Math.round(h * 0.028), fontWeight: 500, tracking: Math.round(h * 0.008), allCaps: true, fill: '#c5c5c5', pin: 'center', animIn: anim('fade', 0.5, 0.5), animOut: anim('fade', 0.3) }),
        ],
        'title-quote',
      ),
  },
  {
    id: 'lt-breaking',
    name: 'Breaking Banner',
    category: 'Lower Thirds',
    description: 'Bold accent block with headline and sub-line. Slides in from the left.',
    build: (w, h) =>
      doc(
        [
          shapeLayer('rect', w * 0.06, h * 0.76, w * 0.015, h * 0.15, { name: 'Accent', fill: '#c9463d', animIn: anim('slideLeft', 0.3), animOut: anim('fade', 0.25) }),
          shapeLayer('rect', w * 0.075, h * 0.76, w * 0.34, h * 0.15, { name: 'Panel', fill: '#0d0d0d', opacity: param(82), animIn: anim('wipe', 0.35, 0.05), animOut: anim('fade', 0.25) }),
          textLayer('BREAKING NEWS', w * 0.095, h * 0.775, { name: 'Kicker', fontSize: Math.round(h * 0.028), fontWeight: 700, tracking: 3, allCaps: true, fill: '#c9463d', animIn: anim('fade', 0.3, 0.3), animOut: anim('fade', 0.2) }),
          textLayer('Headline goes here', w * 0.095, h * 0.815, { name: 'Headline', fontSize: Math.round(h * 0.048), fontWeight: 620, animIn: anim('slideLeft', 0.4, 0.2), animOut: anim('fade', 0.2) }),
        ],
        'lt-breaking',
      ),
  },
  {
    id: 'lt-duo',
    name: 'Duo Lower Third',
    category: 'Lower Thirds',
    description: 'Right-aligned two-line credit with a hairline rule above.',
    build: (w, h) =>
      doc(
        [
          shapeLayer('rect', w * 0.62, h * 0.795, w * 0.32, Math.max(1, h * 0.002), { name: 'Rule', fill: '#e0e0e0', animIn: anim('wipe', 0.4), animOut: anim('fade', 0.25) }),
          textLayer('Jane Doe', w * 0.94, h * 0.81, { name: 'Name', align: 'right', fontSize: Math.round(h * 0.052), fontWeight: 620, pin: 'right', animIn: anim('slideRight', 0.4, 0.1), animOut: anim('fade', 0.25) }),
          textLayer('Director of Photography', w * 0.94, h * 0.868, { name: 'Role', align: 'right', fontSize: Math.round(h * 0.03), fontWeight: 400, fill: '#c5c5c5', pin: 'right', animIn: anim('fade', 0.4, 0.25), animOut: anim('fade', 0.25) }),
        ],
        'lt-duo',
      ),
  },
  {
    id: 'callout-badge',
    name: 'Number Badge',
    category: 'Callouts',
    description: 'Numbered circle badge with a label — made for step-by-step videos.',
    build: (w, h) => {
      const d = h * 0.11;
      return doc(
        [
          shapeLayer('ellipse', w * 0.12, h * 0.2, d, d, { name: 'Badge', fill: '#3d7bd9', animIn: anim('scale', 0.35, 0, 'back'), animOut: anim('scale', 0.2, 0, 'easeIn') }),
          textLayer('1', w * 0.12 + d / 2, h * 0.2 + d / 2, { name: 'Number', align: 'center', anchor: 'center', verticalAlign: 'middle', fontSize: Math.round(d * 0.52), fontWeight: 700, animIn: anim('fade', 0.25, 0.2), animOut: anim('fade', 0.2) }),
          textLayer('Step label', w * 0.12 + d + w * 0.012, h * 0.2 + d * 0.2, { name: 'Label', fontSize: Math.round(h * 0.038), fontWeight: 560, animIn: anim('slideRight', 0.35, 0.25), animOut: anim('fade', 0.2) }),
        ],
        'callout-badge',
      );
    },
  },
  {
    id: 'social-cta-row',
    name: 'Engage Bar',
    category: 'Social',
    description: 'Like / comment / subscribe pill pinned to the bottom center.',
    build: (w, h) =>
      doc(
        [
          shapeLayer('rect', w / 2 - w * 0.21, h * 0.875, w * 0.42, h * 0.07, { name: 'Pill', fill: '#141414', opacity: param(88), radius: Math.round(h * 0.035), animIn: anim('slideUp', 0.4), animOut: anim('slideDown', 0.3) }),
          textLayer('LIKE    •    COMMENT    •    SUBSCRIBE', w / 2, h * 0.91, { name: 'Text', align: 'center', anchor: 'center', verticalAlign: 'middle', fontSize: Math.round(h * 0.028), fontWeight: 640, tracking: 2, allCaps: true, pin: 'center', animIn: anim('fade', 0.35, 0.2), animOut: anim('fade', 0.2) }),
        ],
        'social-cta-row',
      ),
  },
  {
    id: 'shape-frame-corners',
    name: 'Focus Corners',
    category: 'Shapes',
    description: 'Camera-focus corner brackets that draw on around the frame.',
    build: (w, h) => {
      const m = w * 0.08,
        my = h * 0.12,
        len = w * 0.07,
        sw = Math.max(3, h * 0.006);
      const corner = (name: string, x: number, y: number, dx: number, dy: number, delay: number) => [
        shapeLayer('line', x, y, len, 0, { name: name + ' H', stroke: '#e0e0e0', strokeEnabled: true, strokeWidth: sw, fillEnabled: false, x2: dx * len, y2: 0, animIn: anim('wipe', 0.4, delay), animOut: anim('fade', 0.25) }),
        shapeLayer('line', x, y, 0, len, { name: name + ' V', stroke: '#e0e0e0', strokeEnabled: true, strokeWidth: sw, fillEnabled: false, x2: 0, y2: dy * len, animIn: anim('wipe', 0.4, delay), animOut: anim('fade', 0.25) }),
      ];
      return doc([...corner('TL', m, my, 1, 1, 0), ...corner('TR', w - m, my, -1, 1, 0.1), ...corner('BL', m, h - my, 1, -1, 0.2), ...corner('BR', w - m, h - my, -1, -1, 0.3)], 'shape-frame-corners', 0.8, 0.4);
    },
  },
  {
    id: 'credits-endcard',
    name: 'End Card',
    category: 'Credits',
    description: 'Thanks-for-watching end card with an accent rule and upload line.',
    build: (w, h) =>
      doc(
        [
          textLayer('Thanks for watching', w / 2, h * 0.44, { name: 'Thanks', align: 'center', anchor: 'center', verticalAlign: 'middle', fontSize: Math.round(h * 0.085), fontWeight: 620, pin: 'center', animIn: anim('slideUp', 0.55), animOut: anim('fade', 0.3) }),
          shapeLayer('rect', w / 2 - w * 0.05, h * 0.52, w * 0.1, Math.max(2, h * 0.005), { name: 'Rule', fill: '#3d7bd9', animIn: anim('wipe', 0.5, 0.3), animOut: anim('fade', 0.3) }),
          textLayer('New videos every Friday', w / 2, h * 0.58, { name: 'Schedule', align: 'center', anchor: 'center', fontSize: Math.round(h * 0.034), fontWeight: 400, fill: '#c5c5c5', pin: 'center', animIn: anim('fade', 0.5, 0.5), animOut: anim('fade', 0.3) }),
        ],
        'credits-endcard',
      ),
  },
];

export function templateById(id: string): GraphicTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id) ?? useGraphicsLibrary.getState().entries.filter((e) => e.id === id).map(libraryEntryAsTemplate)[0];
}

export const TEMPLATE_CATEGORIES = Array.from(new Set(TEMPLATES.map((t) => t.category)));

/** An empty document with a single text layer, used by the Type tool / "New Text Layer". */
export function blankTextDocument(w: number, h: number, text = 'New Text Layer'): GraphicDocument {
  return doc([textLayer(text, w / 2, h / 2, { align: 'center', verticalAlign: 'middle', anchor: 'center', fontSize: Math.round(h * 0.07), fontWeight: 500, pin: 'center' })], 'blank', 0, 0);
}
