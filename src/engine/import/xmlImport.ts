import type { Clip, MediaAsset, Sequence, Track } from '../../types/project';
import { useProject } from '../../state/projectStore';
import { useUI } from '../../state/uiStore';

/**
 * Parses FCPXML or Premiere Pro XML files and converts them into VanguardStudioPro sequence/asset structures.
 */
export function parseAndImportXml(xmlContent: string, fileName = 'Imported Project'): string | null {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlContent, 'text/xml');

  if (doc.querySelector('parsererror')) {
    useUI.getState().toast({ kind: 'error', title: 'XML Import Error', message: 'Invalid or corrupted XML file.' });
    return null;
  }

  const isFcpxml = !!doc.querySelector('fcpxml');
  const isPremiere = !!doc.querySelector('xmeml');

  if (!isFcpxml && !isPremiere) {
    useUI.getState().toast({ kind: 'warning', title: 'XML Import', message: 'File is not a recognized FCPXML or Premiere XML file.' });
    return null;
  }

  const seqId = `seq_xml_${Date.now()}`;
  let seqName = fileName.replace(/\.[^.]+$/, '');
  let fps = 30;
  let W = 1920;
  let H = 1080;

  const assets: MediaAsset[] = [];
  const tracks: Track[] = [
    { id: 'v1', kind: 'video', name: 'V1', height: 48, locked: false, muted: false, solo: false, visible: true, targeted: true, syncLocked: true, volume: { value: 0 }, pan: { value: 0 }, effects: [], showKeyframes: 'clip', output: 'master' },
    { id: 'a1', kind: 'audio', name: 'A1', height: 44, locked: false, muted: false, solo: false, visible: true, targeted: true, syncLocked: true, volume: { value: 0 }, pan: { value: 0 }, effects: [], showKeyframes: 'clip', output: 'master' },
  ];
  const clips: Clip[] = [];

  if (isFcpxml) {
    const projElem = doc.querySelector('project');
    if (projElem?.getAttribute('name')) seqName = projElem.getAttribute('name')!;

    // Assets
    doc.querySelectorAll('asset').forEach((ast, idx) => {
      const id = ast.getAttribute('id') || `ast_${idx}`;
      const name = ast.getAttribute('name') || `Asset ${idx + 1}`;
      const dur = parseFloat(ast.getAttribute('duration') || '10');
      assets.push({
        id,
        kind: 'video',
        name,
        binId: null,
        label: 'cerulean',
        duration: dur,
        hasVideo: ast.getAttribute('hasVideo') !== '0',
        hasAudio: ast.getAttribute('hasAudio') !== '0',
        offline: true,
        createdAt: Date.now(),
        meta: {},
      });
    });

    // Clips inside spine
    let currentStart = 0;
    doc.querySelectorAll('spine > clip, spine > asset-clip, spine > ref-clip').forEach((cElem, idx) => {
      const name = cElem.getAttribute('name') || `Clip ${idx + 1}`;
      const durSec = parseFloat(cElem.getAttribute('duration') || '5');
      const startSec = cElem.getAttribute('offset') ? parseFloat(cElem.getAttribute('offset')!) : currentStart;
      const inSec = cElem.getAttribute('start') ? parseFloat(cElem.getAttribute('start')!) : 0;
      const refId = cElem.getAttribute('ref') || cElem.getAttribute('asset');

      const startFrame = Math.round(startSec * fps);
      const durFrames = Math.max(1, Math.round(durSec * fps));

      clips.push({
        id: `c_${idx}_${Date.now()}`,
        trackId: 'v1',
        assetId: refId || null,
        name,
        start: startFrame,
        duration: durFrames,
        inPoint: inSec,
        speed: 1,
        reversed: false,
        maintainPitch: true,
        enabled: true,
        label: 'cerulean',
        linkId: null,
        groupId: null,
        motion: { position: { value: [0.5, 0.5] }, scale: { value: 100 }, scaleWidth: { value: 100 }, uniformScale: true, rotation: { value: 0 }, anchor: { value: [0.5, 0.5] }, opacity: { value: 100 }, blendMode: 'normal', antiFlicker: { value: 0 } },
        audio: { gain: 0, volume: { value: 0 }, pan: { value: 0 }, muted: false, channelMode: 'stereo', invertPhase: false },
        effects: [],
        transitionIn: null,
        transitionOut: null,
        markers: [],
      });

      currentStart = startSec + durSec;
    });
  } else if (isPremiere) {
    const seqElem = doc.querySelector('sequence');
    if (seqElem?.querySelector('name')?.textContent) {
      seqName = seqElem.querySelector('name')!.textContent!;
    }
    const tb = doc.querySelector('timebase')?.textContent;
    if (tb) fps = parseInt(tb, 10) || 30;

    const widthElem = doc.querySelector('width')?.textContent;
    const heightElem = doc.querySelector('height')?.textContent;
    if (widthElem) W = parseInt(widthElem, 10) || 1920;
    if (heightElem) H = parseInt(heightElem, 10) || 1080;

    // Video tracks
    doc.querySelectorAll('media > video > track').forEach((trElem, trIdx) => {
      const trackId = trIdx === 0 ? 'v1' : `v_${trIdx + 1}`;
      if (trIdx > 0) {
        tracks.push({ id: trackId, kind: 'video', name: `V${trIdx + 1}`, height: 48, locked: false, muted: false, solo: false, visible: true, targeted: false, syncLocked: true, volume: { value: 0 }, pan: { value: 0 }, effects: [], showKeyframes: 'clip', output: 'master' });
      }

      trElem.querySelectorAll('clipitem').forEach((item, cIdx) => {
        const name = item.querySelector('name')?.textContent || `Clip ${cIdx + 1}`;
        const start = parseInt(item.querySelector('start')?.textContent || '0', 10);
        const end = parseInt(item.querySelector('end')?.textContent || '30', 10);
        const inPt = parseInt(item.querySelector('in')?.textContent || '0', 10) / fps;

        clips.push({
          id: `c_p_${trIdx}_${cIdx}_${Date.now()}`,
          trackId,
          assetId: null,
          name,
          start,
          duration: Math.max(1, end - start),
          inPoint: inPt,
          speed: 1,
          reversed: false,
          maintainPitch: true,
          enabled: true,
          label: 'cerulean',
          linkId: null,
          groupId: null,
          motion: { position: { value: [0.5, 0.5] }, scale: { value: 100 }, scaleWidth: { value: 100 }, uniformScale: true, rotation: { value: 0 }, anchor: { value: [0.5, 0.5] }, opacity: { value: 100 }, blendMode: 'normal', antiFlicker: { value: 0 } },
          audio: { gain: 0, volume: { value: 0 }, pan: { value: 0 }, muted: false, channelMode: 'stereo', invertPhase: false },
          effects: [],
          transitionIn: null,
          transitionOut: null,
          markers: [],
        });
      });
    });
  }

  // Commit sequence to project
  useProject.getState().update('Import XML Sequence', (p) => {
    assets.forEach((a) => {
      if (!p.assets.some((x) => x.id === a.id)) p.assets.push(a);
    });

    const newSeq: Sequence = {
      id: seqId,
      name: seqName,
      settings: { ...p.settings.defaultSequence, width: W, height: H, fps },
      tracks,
      clips,
      markers: [],
      captions: [],
      captionTrack: { enabled: false, burnIn: false, style: { fontFamily: 'Inter', fontSize: 48, fontWeight: 500, italic: false, color: '#f0f0f0', backgroundColor: '#000000', backgroundOpacity: 0.6, edge: 'none', edgeColor: '#000000', align: 'center', position: 0.9, maxWidth: 0.8, letterSpacing: 0 }, name: 'Captions' },
      inPoint: null,
      outPoint: null,
      workArea: { enabled: false, start: 0, end: 300 },
      view: { pixelsPerFrame: 10, scrollFrame: 0, scrollY: 0, playhead: 0 },
      label: 'cerulean',
      binId: null,
      createdAt: Date.now(),
      modifiedAt: Date.now(),
    };

    p.sequences.push(newSeq);
    p.openSequenceIds.push(seqId);
    p.activeSequenceId = seqId;
  });

  useUI.getState().toast({ kind: 'success', title: 'XML Import', message: `Imported "${seqName}" (${clips.length} clips).` });
  return seqId;
}
