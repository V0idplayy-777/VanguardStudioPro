import React, { Suspense } from 'react';
import type { PanelId } from '../../state/uiStore';
import { useUI } from '../../state/uiStore';
import { useActiveSequence, useProject, findAsset } from '../../state/projectStore';
import { ProjectPanel } from '../panels/ProjectPanel';
import { SourceMonitor } from '../monitors/SourceMonitor';
import { ProgramMonitor } from '../monitors/ProgramMonitor';
import { TimelinePanel } from '../timeline/Timeline';
import { EffectsPanel } from '../panels/EffectsPanel';
import { EffectControlsPanel } from '../panels/EffectControls';
import { AudioTrackMixer, AudioClipMixer, AudioMetersPanel, LoudnessPanel } from '../panels/AudioPanels';
import { LumetriPanel } from '../panels/LumetriPanel';
import { ScopesPanel } from '../panels/ScopesPanel';
import { EssentialGraphicsPanel } from '../panels/EssentialGraphics';
import { CaptionsPanel, MarkersPanel, HistoryPanel, InfoPanel, MetadataPanel, EventsPanel, LearnPanel } from '../panels/UtilityPanels';
import { ExportPanel } from '../panels/ExportPanel';
import { ToolsPanel, LibrariesPanel, MediaBrowserPanel } from '../panels/MiscPanels';

class PanelBoundary extends React.Component<{ children: React.ReactNode; name: string }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="empty" style={{ padding: 16 }}>
          <strong>The {this.props.name} panel hit an error</strong>
          <div style={{ fontSize: 11, color: 'var(--c-danger)', whiteSpace: 'pre-wrap', textAlign: 'left', maxHeight: 120, overflow: 'auto', margin: '6px 0' }}>{String(this.state.error.message)}</div>
          <button type="button" className="btn sm" onClick={() => this.setState({ error: null })}>Try again</button>
        </div>
      );
    }
    return this.props.children;
  }
}

const REGISTRY: Record<PanelId, React.ComponentType> = {
  project: ProjectPanel,
  source: SourceMonitor,
  program: ProgramMonitor,
  timeline: TimelinePanel,
  effects: EffectsPanel,
  effectControls: EffectControlsPanel,
  audioMeters: AudioMetersPanel,
  audioMixer: AudioTrackMixer,
  audioClipMixer: AudioClipMixer,
  lumetri: LumetriPanel,
  scopes: ScopesPanel,
  essentialGraphics: EssentialGraphicsPanel,
  captions: CaptionsPanel,
  markers: MarkersPanel,
  history: HistoryPanel,
  info: InfoPanel,
  metadata: MetadataPanel,
  export: ExportPanel,
  libraries: LibrariesPanel,
  events: EventsPanel,
  tools: ToolsPanel,
  loudness: LoudnessPanel,
  mediaBrowser: MediaBrowserPanel,
  learn: LearnPanel,
};

export function PanelContent({ panel }: { panel: PanelId }) {
  const Cmp = REGISTRY[panel];
  return (
    <PanelBoundary name={panel}>
      <Suspense fallback={null}>
        <Cmp />
      </Suspense>
    </PanelBoundary>
  );
}

/** Contextual subtitle shown next to the tab title (sequence name, clip name...). Hook-safe: called from a component. */
export function panelSubtitle(panel: PanelId): string | null {
  const seq = useActiveSequence();
  const sel = useUI((s) => s.selection.clipIds);
  const sourceId = useUI((s) => s.sourceAssetId);
  const project = useProject((s) => s.project);
  const history = useProject((s) => s.past.length);
  switch (panel) {
    case 'timeline':
    case 'program':
      return seq ? seq.name : null;
    case 'source':
      return sourceId ? findAsset(project, sourceId)?.name ?? null : null;
    case 'effectControls':
    case 'lumetri': {
      const c = seq?.clips.find((x) => x.id === sel[0]);
      return c ? c.name : null;
    }
    case 'project':
      return project.settings.name || null;
    case 'history':
      return history ? `${history}` : null;
    default:
      return null;
  }
}
