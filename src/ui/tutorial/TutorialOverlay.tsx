import React, { useEffect, useState, useLayoutEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useTutorial } from '../../state/tutorialStore';
import { useProject, createSequence } from '../../state/projectStore';
import { useUI, toast } from '../../state/uiStore';
import { usePlayback } from '../../engine/playback/playback';
import { cmd } from '../../app/commands';
import { uid } from '../../engine/util';
import { Icon } from '../icons';
import { Button, Checkbox } from '../controls';
import { blankTextDocument, textLayer } from '../graphics/templates';
import { param } from '../../types/project';
import type { MediaAsset } from '../../types/project';
import { getEffectDef, defaultEffectParams } from '../../engine/effects/registry';

type TutorialStep = {
  id: string;
  title: string;
  description: string;
  long?: string;
  target?: string; // CSS selector for spotlight
  position?: 'center' | 'top' | 'bottom' | 'left' | 'right';
  actionLabel?: string;
  action?: () => Promise<void> | void;
  skipAction?: boolean; // if true, action is optional and doesn't block next
  icon?: string;
  highlight?: string;
};

const STEPS: TutorialStep[] = [
  {
    id: 'welcome',
    title: 'Welcome to Vanguard Studio Pro',
    description: 'A professional video editor that runs entirely in your browser. No uploads, no servers — your media never leaves this machine.',
    long: "In the next 2 minutes we'll build your first edit together: a background, a title, an effect, and an export. You can skip anytime, and replay the tour from Help → Welcome Tutorial.",
    position: 'center',
    icon: 'logo',
  },
  {
    id: 'workspace',
    title: 'Your workspace',
    description: 'Top bar switches workspaces: Editing, Color, Effects, Audio, Graphics, etc. Panels are dockable — drag tabs to rearrange, double-click to maximize, ` to toggle.',
    long: 'The layout is saved automatically in this browser. We start in Editing — the classic NLE layout with Project, Source, Program, Timeline, Effects, and Audio.',
    target: '.menubar .workspaces',
    position: 'bottom',
    icon: 'layout',
  },
  {
    id: 'project',
    title: 'Project panel — your media library',
    description: "This is where your clips, images, audio and sequences live. Normally you'd drag & drop files anywhere, but for this tour we'll create sample media for you.",
    long: 'Bins help organize. Search, labels, icons/list view, and right-click for Interpret Footage, Proxy, and more.',
    target: "[data-panel='project']",
    position: 'right',
    icon: 'project',
    actionLabel: 'Create sample media',
  },
  {
    id: 'timeline',
    title: 'Timeline — build your story',
    description: 'Tracks are lanes: V1, V2 for video, A1, A2 for audio. Clips live on tracks. Let\'s place the sample media onto the timeline at the playhead.',
    long: 'Try: hover near clip edges to trim, press C for Razor, Ctrl+K to cut at playhead, Q/W to ripple-trim, S to toggle snapping, V for Selection tool.',
    target: "[data-panel='timeline']",
    position: 'top',
    icon: 'panelTimeline',
    actionLabel: 'Add to timeline',
  },
  {
    id: 'program',
    title: 'Program monitor — see your edit',
    description: 'Shows what the playhead sees. Space to play/pause, J/K/L for shuttle (1x,2x,4x,8x), I/O to mark In/Out, arrow keys to nudge 1 frame (Shift+arrow = 5x).',
    long: 'Drag the time ruler to scrub. The transport has safe margins, overlays, zoom, and a transparency grid. Your first clip should be visible now!',
    target: "[data-panel='program']",
    position: 'left',
    icon: 'play',
  },
  {
    id: 'trim',
    title: 'Trim & cut',
    description: 'Hover near clip edges — drag to trim. Select a clip and drag its body to move. Hold Alt to temporarily disable snapping. Try trimming the blue background a little shorter.',
    long: 'Pro tip: Linked Selection (chain icon) keeps video+audio together. Ripple Delete closes gaps. Use Slip (Y) and Slide (U) tools for fine timing.',
    target: "[data-panel='timeline'] .tl-ruler",
    position: 'bottom',
    icon: 'razor',
  },
  {
    id: 'effects',
    title: 'Effects & transitions',
    description: 'Effects panel holds 60+ GPU effects. Drag one onto a clip, then tweak in Effect Controls. Transitions (Ctrl+D) live between clips.',
    long: "Let's add a little polish — a Lumetri color tweak and a cross-dissolve. You can keyframe almost any parameter.",
    target: "[data-panel='effects']",
    position: 'left',
    icon: 'panelEffects',
    actionLabel: 'Add effect to first clip',
  },
  {
    id: 'graphics',
    title: 'Titles & graphics',
    description: 'Essential Graphics builds text, shapes, layer stacks, with in/out animations. Select your title clip in the timeline to edit its text, font, and style.',
    long: 'Templates browser has ready-made lower thirds, titles, callouts. Drag a template to the timeline — every layer stays editable.',
    target: "[data-panel='essentialGraphics']",
    position: 'left',
    icon: 'clipTitle',
    actionLabel: 'Edit title',
  },
  {
    id: 'export',
    title: 'Export — share your work',
    description: 'When ready, export via WebCodecs to H.264, HEVC, VP9, AV1, GIF, image sequences, WAV, EDL, etc. All local, nothing uploaded. Files download as they finish.',
    long: 'Render Queue lets you batch several sequences or presets. Export panel shows estimated size, burn-captions, and proxy toggle.',
    target: "[data-panel='export']",
    position: 'left',
    icon: 'export',
    actionLabel: 'Open Export',
  },
  {
    id: 'done',
    title: 'You did it! 🎬',
    description: 'You built your first edit: background, title, effect, and you know where everything lives. Continue editing, import your own media, or replay this tour anytime.',
    long: 'Tip: Press Ctrl+Shift+P for Command Palette — fuzzy-search every command, panel, effect, asset. And check Settings (Ctrl+,) for appearance, import defaults, and more.',
    position: 'center',
    icon: 'sparkle',
  },
];

function useTargetRect(selector?: string) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const raf = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (!selector) {
      setRect(null);
      return;
    }
    const update = () => {
      const el = document.querySelector(selector) as HTMLElement | null;
      if (el) {
        setRect(el.getBoundingClientRect());
      } else {
        setRect(null);
      }
    };
    update();
    const onResize = () => {
      if (raf.current) cancelAnimationFrame(raf.current);
      raf.current = requestAnimationFrame(update);
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onResize, true);
    const iv = window.setInterval(update, 500);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onResize, true);
      window.clearInterval(iv);
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [selector]);

  return rect;
}

function createSampleAssets(): MediaAsset[] {
  const seq = useProject.getState().project.sequences.find(s => s.id === useProject.getState().project.activeSequenceId);
  const w = seq?.settings.width ?? 1920;
  const h = seq?.settings.height ?? 1080;
  const fps = seq?.settings.fps ?? 30;

  const assets: MediaAsset[] = [];

  const blue = cmd.newGenerator('colorMatte', { color: '#3d7bd9' }, 'Tutorial – Vanguard Blue');
  const orange = cmd.newGenerator('colorMatte', { color: '#cf7b35' }, 'Tutorial – Sunset Orange');
  assets.push(blue, orange);

  // Text graphic
  const graphic = cmd.newGenerator('graphic', {}, 'Tutorial – Welcome Title');
  useProject.getState().update('Tutorial graphic setup', (p) => {
    const a = p.assets.find(x => x.id === graphic.id);
    if (!a) return;
    const doc = blankTextDocument(w, h, 'Welcome to Vanguard');
    // Make it more interesting: add a subtitle layer
    const subtitle = textLayer('Your first edit — built in 2 minutes', w / 2, h * 0.58, {
      name: 'Subtitle',
      align: 'center',
      anchor: 'center',
      fontSize: Math.round(h * 0.036),
      fontWeight: 380,
      fill: '#c5c5c5',
      pin: 'center',
    });
    doc.layers[0].fontSize = Math.round(h * 0.09);
    doc.layers[0].fontWeight = 620;
    doc.layers[0].align = 'center';
    doc.layers[0].anchor = 'center';
    doc.layers[0].pin = 'center';
    doc.layers.push(subtitle);
    a.graphic = doc;
    a.width = w;
    a.height = h;
    a.fps = fps;
    a.duration = 5;
  });
  assets.push(graphic);

  return assets;
}

export function TutorialOverlay() {
  const { isActive, currentStep, totalSteps, next, prev, skip, complete, setDontShowAgain, progress } = useTutorial();
  const [busy, setBusy] = useState(false);
  const [sampleIds, setSampleIds] = useState<string[]>([]);
  const step = useMemo(() => STEPS[currentStep] ?? STEPS[0], [currentStep]);
  const rect = useTargetRect(isActive ? step.target : undefined);

  // Update total steps in store once
  useEffect(() => {
    useTutorial.getState().setTotalSteps(STEPS.length);
  }, []);

  const cardStyle = useMemo(() => {
    if (!isActive) return {};
    if (!rect || step.position === 'center') {
      return {
        left: '50%',
        top: '50%',
        transform: 'translate(-50%, -50%)',
      } as React.CSSProperties;
    }
    const pad = 16;
    const cardW = 380;
    const cardH = 320; // approximate
    let left = 0, top = 0;
    switch (step.position) {
      case 'bottom':
        left = rect.left + rect.width / 2 - cardW / 2;
        top = rect.bottom + pad;
        break;
      case 'top':
        left = rect.left + rect.width / 2 - cardW / 2;
        top = rect.top - cardH - pad;
        break;
      case 'right':
        left = rect.right + pad;
        top = rect.top + rect.height / 2 - cardH / 2;
        break;
      case 'left':
        left = rect.left - cardW - pad;
        top = rect.top + rect.height / 2 - cardH / 2;
        break;
      default:
        left = rect.left + rect.width / 2 - cardW / 2;
        top = rect.bottom + pad;
    }
    // Clamp to viewport
    left = Math.max(12, Math.min(window.innerWidth - cardW - 12, left));
    top = Math.max(12, Math.min(window.innerHeight - cardH - 12, top));
    return { left, top, position: 'absolute' as const };
  }, [rect, step, isActive]);

  const handleAction = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (step.id === 'project') {
        const assets = createSampleAssets();
        setSampleIds(assets.map(a => a.id));
        toast('success', 'Sample media created', `${assets.length} items added to Project panel`);
        // Select them in project panel
        const { projectSelection } = await import('../../app/commands');
        projectSelection.set(assets.map(a => a.id));
        useUI.getState().setFocusedPanel('project');
      } else if (step.id === 'timeline') {
        const project = useProject.getState().project;
        let ids = sampleIds;
        if (!ids.length) {
          // fallback: find tutorial assets
          ids = project.assets.filter(a => a.name.startsWith('Tutorial –')).map(a => a.id);
        }
        const assets = project.assets.filter(a => ids.includes(a.id));
        if (!assets.length) {
          // create if missing
          const created = createSampleAssets();
          setSampleIds(created.map(a => a.id));
          const fresh = useProject.getState().project.assets.filter(a => created.map(c => c.id).includes(a.id));
          cmd.placeAssetsAt(fresh, usePlayback.getState().playhead, 'overwrite');
        } else {
          cmd.placeAssetsAt(assets, usePlayback.getState().playhead, 'overwrite');
        }
        toast('success', 'Added to timeline', 'Your first clips are on V1. Press Space to preview!');
        useUI.getState().setFocusedPanel('timeline');
      } else if (step.id === 'effects') {
        const seq = useProject.getState().project.sequences.find(s => s.id === useProject.getState().project.activeSequenceId);
        const firstClip = seq?.clips[0];
        if (firstClip) {
          const def = getEffectDef('lumetri');
          if (def) {
            useProject.getState().update('Tutorial add effect', (p) => {
              const s = p.sequences.find(x => x.id === seq!.id);
              const c = s?.clips.find(x => x.id === firstClip.id);
              if (!c) return;
              if (!c.effects.some(e => e.type === 'lumetri')) {
                c.effects.push({ id: uid('fx'), type: 'lumetri', enabled: true, params: defaultEffectParams(def), masks: [] });
              }
            });
            useUI.getState().selectClips([firstClip.id]);
            useUI.getState().setFocusedPanel('effectControls');
            useUI.getState().setWorkspace('color');
            toast('success', 'Lumetri added', 'Tweak exposure and color in Effect Controls / Lumetri panel');
          }
        } else {
          toast('info', 'No clip yet', 'Add clips to timeline first (previous step)');
        }
      } else if (step.id === 'graphics') {
        const seq = useProject.getState().project.sequences.find(s => s.id === useProject.getState().project.activeSequenceId);
        const graphicClip = seq?.clips.find(c => {
          const a = useProject.getState().project.assets.find(as => as.id === c.assetId);
          return a?.name.includes('Welcome Title');
        });
        if (graphicClip) {
          useUI.getState().selectClips([graphicClip.id]);
          useUI.getState().setWorkspace('graphics');
          useUI.getState().setFocusedPanel('essentialGraphics');
        } else {
          useUI.getState().setWorkspace('graphics');
        }
      } else if (step.id === 'export') {
        useUI.getState().openModal({ kind: 'export' });
      }

      // Auto advance after action for some steps
      if (['project', 'timeline', 'effects'].includes(step.id)) {
        setTimeout(() => next(), 400);
      }
    } catch (e) {
      console.error(e);
      toast('error', 'Tutorial action failed', String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!isActive) return null;

  const progressPct = ((currentStep + 1) / totalSteps) * 100;

  return createPortal(
    <div className="tutorial-overlay" role="dialog" aria-modal="true" aria-label="Welcome tutorial">
      {/* Dim background */}
      <div className="tutorial-backdrop" onClick={() => { /* prevent closing by backdrop click */ }} />

      {/* Spotlight highlight */}
      {rect ? (
        <>
          <div
            className="tutorial-spotlight"
            style={{
              left: rect.left - 6,
              top: rect.top - 6,
              width: rect.width + 12,
              height: rect.height + 12,
            }}
          />
          <div className="tutorial-spotlight-glow" style={{
            left: rect.left - 6,
            top: rect.top - 6,
            width: rect.width + 12,
            height: rect.height + 12,
          }} />
        </>
      ) : null}

      {/* Card */}
      <div className="tutorial-card" style={cardStyle}>
        <div className="tutorial-card-head">
          <div className="tutorial-icon">
            <Icon name={(step.icon as any) ?? 'sparkle'} size={16} />
          </div>
          <div className="tutorial-step-indicator">
            Step {currentStep + 1} of {totalSteps}
          </div>
          <button className="tutorial-close" onClick={skip} title="Skip tutorial (Esc)">
            <Icon name="close" size={12} />
          </button>
        </div>

        <div className="tutorial-progress">
          <div className="tutorial-progress-bar" style={{ width: `${progressPct}%` }} />
        </div>

        <h2 className="tutorial-title">{step.title}</h2>
        <p className="tutorial-desc">{step.description}</p>
        {step.long ? <p className="tutorial-long">{step.long}</p> : null}

        <div className="tutorial-actions">
          {step.actionLabel ? (
            <Button primary onClick={handleAction} disabled={busy}>
              {busy ? 'Working…' : step.actionLabel}
            </Button>
          ) : null}
          <span className="spacer" />
          {currentStep > 0 ? <Button onClick={prev}>Back</Button> : null}
          {currentStep < totalSteps - 1 ? (
            <Button primary={!(step.actionLabel)} onClick={next}>
              {currentStep === 0 ? 'Start tour' : 'Next'}
            </Button>
          ) : (
            <Button primary onClick={complete}>Finish</Button>
          )}
        </div>

        <div className="tutorial-foot">
          <Checkbox checked={progress.dontShowAgain} onChange={setDontShowAgain} label="Don't show again" />
          <span className="spacer" />
          <button className="tutorial-skip" onClick={skip}>Skip tutorial</button>
        </div>
      </div>

      {/* Bottom hint */}
      <div className="tutorial-hint">
        <span>Press <kbd>Esc</kbd> to skip • <kbd>←</kbd> <kbd>→</kbd> to navigate • Tutorial progress is saved locally</span>
      </div>
    </div>,
    document.body
  );
}

// Keyboard handling for tutorial
export function useTutorialShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useTutorial.getState();
      if (!st.isActive) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        st.skip();
      } else if (e.key === 'ArrowRight' || e.key === 'Enter') {
        if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA') return;
        e.preventDefault();
        st.next();
      } else if (e.key === 'ArrowLeft') {
        if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA') return;
        e.preventDefault();
        st.prev();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
