import '@fontsource-variable/inter';
import './styles/global.css';
import './styles/controls.css';
import './styles/app.css';
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MenuBar } from './ui/MenuBar';
import { DockRoot, useMaximizeShortcut } from './ui/dock/Dock';
import { ContextMenuHost, ToastHost } from './ui/controls';
import { ModalHost } from './ui/modals/Modals';
import { useGlobalShortcuts } from './app/shortcuts';
import { useUI, toast, logEvent } from './state/uiStore';
import { useProject, useActiveSequence, sequenceDuration } from './state/projectStore';
import { usePlayback } from './engine/playback/playback';
import { startAutosave, autosaveInfo, openProjectFile } from './engine/project/serialize';
import { classifyFile, importFiles } from './engine/media/importer';
import { onEgg, type EggEvent } from './easter/eggs';
import { cmd } from './app/commands';
import { framesToTimecode } from './engine/timecode';
import { Icon } from './ui/icons';
import { parseSRT, parseVTT } from './engine/captions/subtitles';
import { uid } from './engine/util';
import { useSettings, applyDocumentSettings } from './state/settingsStore';
import { CommandPalette } from './ui/CommandPalette';

function StatusBar() {
  const seq = useActiveSequence();
  const dirty = useProject((s) => s.dirty);
  const autosavedAt = useProject((s) => s.autosavedAt);
  const project = useProject((s) => s.project);
  const playing = usePlayback((s) => s.playing);
  const rate = usePlayback((s) => s.rate);
  const dropped = usePlayback((s) => s.droppedFrames);
  const tool = useUI((s) => s.tool);
  const snapping = useUI((s) => s.snapping);
  const sel = useUI((s) => s.selection.clipIds.length);
  const events = useUI((s) => s.events);
  const errors = events.filter((e) => e.kind === 'error').length;
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 30000);
    return () => window.clearInterval(t);
  }, []);
  const ago = autosavedAt ? Math.round((Date.now() - autosavedAt) / 60000) : null;
  const mediaCount = project.assets.filter((a) => a.kind !== 'sequence').length;
  const offline = project.assets.filter((a) => a.offline).length;
  const openLearn = () => useUI.getState().openModal({ kind: 'keyboardShortcuts' });
  return (
    <div className="statusbar" role="status">
      <span className="sb-item" title={dirty ? 'Unsaved changes' : 'All changes saved'}>
        <span className={`dot${dirty ? ' busy' : ''}`} />
        {dirty ? 'Modified' : 'Saved'}
        {ago != null ? ` - autosaved ${ago < 1 ? 'just now' : `${ago} min ago`}` : ''}
      </span>
      {seq ? (
        <span className="sb-item">
          {seq.settings.width}x{seq.settings.height} {seq.settings.fps} fps - {framesToTimecode(sequenceDuration(seq), seq.settings.fps, seq.settings.dropFrame)} - {seq.clips.length} clip{seq.clips.length === 1 ? '' : 's'}
        </span>
      ) : null}
      <span className="sb-item">{mediaCount} media{offline ? ` (${offline} offline)` : ''}</span>
      {sel ? <span className="sb-item">{sel} selected</span> : null}
      <span className="right">
        {playing ? <span className="sb-item">{rate === 1 ? 'Playing' : `Shuttle ${rate > 0 ? '' : '-'}${Math.abs(rate)}x`}{dropped ? ` - ${dropped} dropped` : ''}</span> : null}
        <span className="sb-item">Tool: {tool}</span>
        <span className="sb-item click" onClick={() => useUI.getState().setSnapping(!snapping)} title="Toggle snapping (S)">
          <Icon name="snap" size={10} /> {snapping ? 'Snap on' : 'Snap off'}
        </span>
        {errors ? (
          <span className="sb-item click" style={{ color: 'var(--c-danger)' }} onClick={() => useUI.getState().setWorkspace('review')} title="Open the Events panel (Review workspace)">
            <Icon name="error" size={10} /> {errors} error{errors === 1 ? '' : 's'}
          </span>
        ) : null}
        <span className="sb-item click" onClick={openLearn} title="Keyboard shortcuts">
          <Icon name="keyboard" size={10} /> Shortcuts
        </span>
      </span>
    </div>
  );
}

function EggOverlay() {
  const [egg, setEgg] = useState<EggEvent | null>(null);
  useEffect(() => {
    let timer = 0;
    const off = onEgg((e) => {
      setEgg(e);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setEgg(null), 9000);
    });
    return () => {
      off();
      window.clearTimeout(timer);
    };
  }, []);
  if (!egg) return null;
  return (
    <div className="egg-overlay">
      <div className="egg-card" style={{ pointerEvents: 'auto' }} onClick={() => setEgg(null)} role="dialog" aria-label={egg.title}>
        <h3>{egg.title}</h3>
        <p>{egg.message}</p>
        {egg.sub ? <div className="sub">{egg.sub}</div> : null}
      </div>
    </div>
  );
}

/** Whole-window drop target: media goes to the project, .vsproj opens, .srt/.vtt become captions. */
function useWindowDrop() {
  useEffect(() => {
    let depth = 0;
    const over = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    };
    const enter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      depth++;
      document.body.classList.add('file-drag');
    };
    const leave = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      depth = Math.max(0, depth - 1);
      if (!depth) document.body.classList.remove('file-drag');
    };
    const drop = async (e: DragEvent) => {
      depth = 0;
      document.body.classList.remove('file-drag');
      if (!e.dataTransfer?.files.length) return;
      // Panels that handle their own drops (project bins, timeline) stop propagation, so this is the fallback.
      e.preventDefault();
      const files = Array.from(e.dataTransfer.files);
      const projects = files.filter((f) => classifyFile(f) === 'project');
      const captions = files.filter((f) => classifyFile(f) === 'captions');
      const media = files.filter((f) => !projects.includes(f) && !captions.includes(f));
      if (projects[0]) {
        try {
          const { project, restored, missing } = await openProjectFile(projects[0]);
          useProject.getState().loadProject(project);
          usePlayback.setState({ playhead: 0 });
          useUI.getState().clearSelection();
          toast('success', 'Project opened', `${project.settings.name} - ${restored} media restored${missing.length ? `, ${missing.length} offline` : ''}`);
          if (missing.length) useUI.getState().openModal({ kind: 'linkMedia', payload: { assetIds: missing.map((m) => m.id) } });
        } catch (err) {
          toast('error', 'Could not open project', String((err as Error).message ?? err));
        }
      }
      if (captions.length) {
        const seq = useActiveSequenceSnapshot();
        if (seq) {
          for (const f of captions) {
            const text = await f.text();
            const items = f.name.toLowerCase().endsWith('.vtt') ? parseVTT(text, seq.settings.fps) : parseSRT(text, seq.settings.fps);
            useProject.getState().update('Import captions', (p) => {
              const s = p.sequences.find((x) => x.id === seq.id);
              if (!s) return;
              s.captions.push(...items.map((c) => ({ ...c, id: uid('cap') })));
              s.captions.sort((a, b) => a.start - b.start);
              s.captionTrack.enabled = true;
            });
            toast('success', 'Captions imported', `${items.length} items from ${f.name}`);
          }
        }
      }
      if (media.length) {
        const assets = await importFiles(media, { binId: useUI.getState().currentBinId });
        if (assets.length) toast('success', 'Imported', `${assets.length} item${assets.length === 1 ? '' : 's'} added to the project`);
      }
    };
    window.addEventListener('dragover', over);
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, []);
}
function useActiveSequenceSnapshot() {
  const p = useProject.getState().project;
  return p.sequences.find((s) => s.id === p.activeSequenceId) ?? null;
}

function App() {
  useGlobalShortcuts();
  useMaximizeShortcut();
  useWindowDrop();
  const hamburger = useUI((s) => s.hamburgerMode);
  const turtle = useUI((s) => s.turtleMode);
  const inverted = useUI((s) => s.colorInverted);
  const autoSave = useProject((s) => s.project.settings.autoSaveEnabled);
  const interval = useProject((s) => s.project.settings.autoSaveIntervalMinutes);

  // Application settings: apply theme/a11y on boot and follow changes. The
  // default program quality also seeds the UI store, and the startup
  // workspace decides which layout opens first.
  useEffect(() => {
    const s = useSettings.getState();
    applyDocumentSettings(s);
    useUI.setState({ programQuality: s.defaultProgramQuality });
    // Workspace at launch: a fixed one, or the last used (persisted below).
    const valid: string[] = ['assembly', 'editing', 'color', 'effects', 'audio', 'graphics', 'captions', 'review', 'export'];
    if (s.startupWorkspace === 'last') {
      const w = localStorage.getItem('vsp.lastWorkspace');
      if (w && valid.includes(w)) useUI.setState({ workspace: w as any });
    } else if (valid.includes(s.startupWorkspace)) {
      useUI.setState({ workspace: s.startupWorkspace as any });
    }
    return useSettings.subscribe((next) => {
      applyDocumentSettings(next);
      if (next.defaultProgramQuality !== useUI.getState().programQuality) useUI.setState({ programQuality: next.defaultProgramQuality });
    });
  }, []);

  // Remember the workspace for the 'last used' startup option.
  useEffect(() => {
    localStorage.setItem('vsp.lastWorkspace', useUI.getState().workspace);
    return useUI.subscribe((state, prev) => {
      if (state.workspace !== prev.workspace) localStorage.setItem('vsp.lastWorkspace', state.workspace);
    });
  }, []);

  // Autosave loop follows the preferences.
  useEffect(() => {
    if (!autoSave) return;
    startAutosave(Math.max(1, interval) * 60000);
    return () => {
      import('./engine/project/serialize').then((m) => m.stopAutosave());
    };
  }, [autoSave, interval]);

  // First run: welcome, or offer the autosave if one exists. The timeline itself always starts empty.
  useEffect(() => {
    let cancelled = false;
    autosaveInfo().then((info) => {
      if (cancelled) return;
      const skip = !useSettings.getState().showWelcomeOnStartup;
      if (info) {
        toast('info', 'Autosave available', `${info.name} from ${new Date(info.at).toLocaleString()}. Open it from File, Open Autosaved Version.`);
        logEvent('info', 'Autosave found', `${info.name} at ${new Date(info.at).toLocaleString()}`);
      }
      if (!skip) useUI.getState().openModal({ kind: 'welcome' });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Surface uncaught errors in the Events panel instead of dying silently.
  useEffect(() => {
    const onErr = (e: ErrorEvent) => logEvent('error', e.message, e.error?.stack);
    const onRej = (e: PromiseRejectionEvent) => logEvent('error', String(e.reason?.message ?? e.reason), e.reason?.stack);
    window.addEventListener('error', onErr);
    window.addEventListener('unhandledrejection', onRej);
    return () => {
      window.removeEventListener('error', onErr);
      window.removeEventListener('unhandledrejection', onRej);
    };
  }, []);

  useEffect(() => {
    document.title = `${useProject.getState().project.settings.name} - Vanguard Studio Pro`;
    return useProject.subscribe((s) => {
      document.title = `${s.dirty ? '* ' : ''}${s.project.settings.name} - Vanguard Studio Pro`;
    });
  }, []);

  return (
    <div className={['app', hamburger ? 'hamburger' : '', turtle ? 'turtle' : '', inverted ? 'inverted' : ''].filter(Boolean).join(' ')}>
      <MenuBar />
      <DockRoot />
      <StatusBar />
      <ModalHost />
      <ContextMenuHost />
      <ToastHost />
      <CommandPalette />
      <EggOverlay />
    </div>
  );
}

// Expose a tiny debug surface for power users (also used by tests). Not a feature; not in menus.
(window as any).vsp = { cmd, project: useProject, ui: useUI, playback: usePlayback, settings: useSettings };

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
