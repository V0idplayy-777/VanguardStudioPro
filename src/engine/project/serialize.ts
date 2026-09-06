import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import type { Project, MediaAsset } from '../../types/project';
import { useProject } from '../../state/projectStore';
import { loadMediaBlob, persistMediaBlob, saveProjectAutosave, loadProjectAutosave, clearProjectAutosave } from '../media/mediaDb';
import { registerMedia, hasMedia, getMedia } from '../media/mediaStore';
import { relinkAsset } from '../media/importer';
import { download, sanitizeFilename } from '../util';
import { logEvent, toast } from '../../state/uiStore';

export const PROJECT_EXT = 'vsproj';
export const PROJECT_FORMAT_VERSION = 3;

interface ProjectFileJson {
  format: 'vanguard-studio-pro';
  version: number;
  savedAt: number;
  app: string;
  project: Project;
}

/** Strip runtime-only fields before persisting. */
export function serializeProject(project: Project): ProjectFileJson {
  const clean: Project = JSON.parse(
    JSON.stringify(project, (k, v) => {
      if (k === 'file') return undefined;
      return v;
    }),
  );
  return { format: 'vanguard-studio-pro', version: PROJECT_FORMAT_VERSION, savedAt: Date.now(), app: 'Vanguard Studio Pro', project: clean };
}

export function parseProjectJson(text: string): Project {
  const data = JSON.parse(text) as ProjectFileJson;
  if (data.format !== 'vanguard-studio-pro' || !data.project) throw new Error('Not a Vanguard Studio Pro project file.');
  return migrate(data.project, data.version ?? 1);
}

function migrate(p: Project, from: number): Project {
  // Forward-compat hooks: fill fields missing in older files.
  if (from < 2) {
    for (const s of p.sequences) {
      s.captions ??= [];
      s.markers ??= [];
    }
  }
  if (from < 3) {
    for (const s of p.sequences) for (const c of s.clips) c.markers ??= [];
  }
  return p;
}

/**
 * Save project as .vsproj — a zip containing project.json and, optionally,
 * every imported media file so the project is fully portable.
 */
export async function saveProjectFile(project: Project, opts: { embedMedia: boolean; onProgress?: (msg: string) => void } = { embedMedia: false }): Promise<Blob> {
  const files: Record<string, Uint8Array> = {};
  files['project.json'] = strToU8(JSON.stringify(serializeProject(project), null, 1));
  if (opts.embedMedia) {
    for (const a of project.assets) {
      if (a.kind === 'sequence' || a.kind === 'generator') continue;
      const rec = getMedia(a.id);
      let blob = rec?.blob ?? null;
      if (!blob) blob = await loadMediaBlob(a.id);
      if (!blob) continue;
      opts.onProgress?.(`Packing ${a.name}`);
      files[`media/${a.id}__${sanitizeFilename(a.name)}`] = new Uint8Array(await blob.arrayBuffer());
    }
  }
  const zipped = zipSync(files, { level: opts.embedMedia ? 0 : 6 });
  return new Blob([zipped as BlobPart], { type: 'application/x-vanguard-project' });
}

export async function downloadProject(project: Project, embedMedia: boolean) {
  const blob = await saveProjectFile(project, { embedMedia });
  download(blob, `${sanitizeFilename(project.settings.name)}.${PROJECT_EXT}`);
  useProject.getState().markSaved();
  logEvent('info', `Project saved (${(blob.size / 1024).toFixed(0)} KB${embedMedia ? ', media embedded' : ''})`);
}

export async function openProjectFile(file: File): Promise<{ project: Project; restored: number; missing: MediaAsset[] }> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let project: Project;
  const embedded = new Map<string, Blob>();
  if (file.name.endsWith('.json')) {
    project = parseProjectJson(strFromU8(buf));
  } else {
    const entries = unzipSync(buf);
    const pj = entries['project.json'];
    if (!pj) throw new Error('project.json missing from archive.');
    project = parseProjectJson(strFromU8(pj));
    for (const [name, data] of Object.entries(entries)) {
      if (!name.startsWith('media/')) continue;
      const base = name.slice(6);
      const id = base.split('__')[0];
      embedded.set(id, new Blob([data as BlobPart]));
    }
  }
  const { restored, missing } = await restoreProjectMedia(project, embedded);
  return { project, restored, missing };
}

/** Bring media back online from embedded blobs or IndexedDB cache. */
export async function restoreProjectMedia(project: Project, embedded?: Map<string, Blob>): Promise<{ restored: number; missing: MediaAsset[] }> {
  let restored = 0;
  const missing: MediaAsset[] = [];
  for (const a of project.assets) {
    if (a.kind === 'sequence' || a.kind === 'generator') continue;
    if (hasMedia(a.id) && getMedia(a.id)?.ready) {
      restored++;
      continue;
    }
    let blob = embedded?.get(a.id) ?? null;
    if (!blob) blob = await loadMediaBlob(a.id).catch(() => null);
    if (blob) {
      const f = new File([blob], a.name, { type: blob.type || a.file?.type || '' });
      try {
        await relinkAsset(a, f, true);
        a.offline = false;
        restored++;
      } catch {
        a.offline = true;
        missing.push(a);
      }
    } else {
      a.offline = true;
      missing.push(a);
    }
  }
  return { restored, missing };
}

/* ---------- autosave ---------- */

let autosaveTimer: number | null = null;
let lastAutosavedRevision = -1;

export function startAutosave(intervalMs = 20000) {
  stopAutosave();
  autosaveTimer = window.setInterval(async () => {
    const st = useProject.getState();
    if (st.project.revision === lastAutosavedRevision) return;
    try {
      await saveProjectAutosave(JSON.stringify(serializeProject(st.project)));
      lastAutosavedRevision = st.project.revision;
      st.setAutosavedAt(Date.now());
    } catch (e) {
      logEvent('warning', 'Autosave failed', String(e));
    }
  }, intervalMs);
}

export function stopAutosave() {
  if (autosaveTimer != null) window.clearInterval(autosaveTimer);
  autosaveTimer = null;
}

export async function autosaveNow() {
  const st = useProject.getState();
  await saveProjectAutosave(JSON.stringify(serializeProject(st.project)));
  lastAutosavedRevision = st.project.revision;
  st.setAutosavedAt(Date.now());
}

export async function autosaveInfo(): Promise<{ at: number; name: string } | null> {
  const rec = await loadProjectAutosave();
  if (!rec) return null;
  try {
    const data = JSON.parse(rec.json) as ProjectFileJson;
    return { at: rec.at, name: data.project?.settings?.name ?? 'Untitled' };
  } catch {
    return null;
  }
}

export async function loadAutosavedProject(): Promise<Project | null> {
  const rec = await loadProjectAutosave();
  if (!rec) return null;
  const data = JSON.parse(rec.json) as ProjectFileJson;
  if (!data.project) return null;
  return migrate(data.project, data.version ?? 1);
}

export async function discardAutosave() {
  await clearProjectAutosave();
}

/** Called after import to make sure media survives a reload. */
export async function persistAssetBlob(asset: MediaAsset, blob: Blob) {
  try {
    await persistMediaBlob(asset.id, blob);
  } catch (e) {
    toast('warning', 'Media cache', `Could not cache ${asset.name} for reload: ${String(e)}`);
  }
}

export { registerMedia };
