import type { Project, Sequence } from '../../types/project';

/**
 * Export sequence to Premiere Pro XML (xmeml v4).
 */
export function exportPremiereXml(seq: Sequence, project: Project): string {
  const fps = seq.settings.fps;
  const timebase = Math.round(fps);
  const durFrames = seq.clips.reduce((max, c) => Math.max(max, c.start + c.duration), 0);

  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n`;
  xml += `<xmeml version="4">\n`;
  xml += `  <sequence id="${seq.id}">\n`;
  xml += `    <name>${escapeXml(seq.name)}</name>\n`;
  xml += `    <duration>${durFrames}</duration>\n`;
  xml += `    <rate>\n`;
  xml += `      <timebase>${timebase}</timebase>\n`;
  xml += `      <ntsc>FALSE</ntsc>\n`;
  xml += `    </rate>\n`;
  xml += `    <media>\n`;
  xml += `      <video>\n`;
  xml += `        <format>\n`;
  xml += `          <samplecharacteristics>\n`;
  xml += `            <width>${seq.settings.width}</width>\n`;
  xml += `            <height>${seq.settings.height}</height>\n`;
  xml += `            <rate><timebase>${timebase}</timebase></rate>\n`;
  xml += `          </samplecharacteristics>\n`;
  xml += `        </format>\n`;

  // Group clips by video tracks
  const videoTracks = seq.tracks.filter((t) => t.kind === 'video');
  videoTracks.forEach((tr, trIdx) => {
    xml += `        <track>\n`;
    const clipsOnTrack = seq.clips.filter((c) => c.trackId === tr.id).sort((a, b) => a.start - b.start);
    clipsOnTrack.forEach((c) => {
      const inFrames = Math.round(c.inPoint * fps);
      const outFrames = inFrames + Math.round(c.duration * c.speed);
      xml += `          <clipitem id="${c.id}">\n`;
      xml += `            <name>${escapeXml(c.name)}</name>\n`;
      xml += `            <start>${c.start}</start>\n`;
      xml += `            <end>${c.start + c.duration}</end>\n`;
      xml += `            <in>${inFrames}</in>\n`;
      xml += `            <out>${outFrames}</out>\n`;
      xml += `            <file id="f_${c.assetId || 'gen'}">\n`;
      xml += `              <name>${escapeXml(c.name)}</name>\n`;
      xml += `            </file>\n`;
      xml += `          </clipitem>\n`;
    });
    xml += `        </track>\n`;
  });

  xml += `      </video>\n`;

  // Audio tracks
  xml += `      <audio>\n`;
  const audioTracks = seq.tracks.filter((t) => t.kind === 'audio');
  audioTracks.forEach((tr) => {
    xml += `        <track>\n`;
    const clipsOnTrack = seq.clips.filter((c) => c.trackId === tr.id).sort((a, b) => a.start - b.start);
    clipsOnTrack.forEach((c) => {
      const inFrames = Math.round(c.inPoint * fps);
      const outFrames = inFrames + Math.round(c.duration * c.speed);
      xml += `          <clipitem id="${c.id}">\n`;
      xml += `            <name>${escapeXml(c.name)}</name>\n`;
      xml += `            <start>${c.start}</start>\n`;
      xml += `            <end>${c.start + c.duration}</end>\n`;
      xml += `            <in>${inFrames}</in>\n`;
      xml += `            <out>${outFrames}</out>\n`;
      xml += `          </clipitem>\n`;
    });
    xml += `        </track>\n`;
  });
  xml += `      </audio>\n`;

  xml += `    </media>\n`;
  xml += `  </sequence>\n`;
  xml += `</xmeml>\n`;

  return xml;
}

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
