import type { Project, Sequence } from '../../types/project';

/**
 * Export sequence to FCPXML (Final Cut Pro / DaVinci Resolve format).
 */
export function exportFcpxml(seq: Sequence, project: Project): string {
  const fps = seq.settings.fps;
  const frameDuration = `100/${Math.round(fps * 100)}s`;
  const durSec = (seq.clips.reduce((max, c) => Math.max(max, c.start + c.duration), 0) / fps).toFixed(2);

  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n`;
  xml += `<fcpxml version="1.8">\n`;
  xml += `  <resources>\n`;
  xml += `    <format id="r1" name="FFVideoFormat${seq.settings.height}p${Math.round(fps)}" frameDuration="${frameDuration}" width="${seq.settings.width}" height="${seq.settings.height}"/>\n`;

  // Write assets
  project.assets.forEach((a, idx) => {
    const assetId = `a${idx + 1}`;
    xml += `    <asset id="${assetId}" name="${escapeXml(a.name)}" src="file://localhost/${escapeXml(a.file?.name || a.name)}" duration="${(a.duration || 10).toFixed(2)}s" hasVideo="${a.hasVideo ? '1' : '0'}" hasAudio="${a.hasAudio ? '1' : '0'}"/>\n`;
  });

  xml += `  </resources>\n`;
  xml += `  <library>\n`;
  xml += `    <event name="${escapeXml(project.settings.name || 'Vanguard Export')}">\n`;
  xml += `      <project name="${escapeXml(seq.name)}">\n`;
  xml += `        <sequence format="r1" duration="${durSec}s" tcStart="0s" tcFormat="NDF">\n`;
  xml += `          <spine>\n`;

  // Write clips in track order
  const videoClips = seq.clips
    .filter((c) => {
      const tr = seq.tracks.find((t) => t.id === c.trackId);
      return tr?.kind === 'video';
    })
    .sort((a, b) => a.start - b.start);

  videoClips.forEach((c) => {
    const startSec = (c.start / fps).toFixed(2);
    const durSec = (c.duration / fps).toFixed(2);
    const inSec = c.inPoint.toFixed(2);
    const assetIdx = project.assets.findIndex((a) => a.id === c.assetId);
    const refId = assetIdx >= 0 ? `a${assetIdx + 1}` : 'r1';

    xml += `            <clip name="${escapeXml(c.name)}" offset="${startSec}s" ref="${refId}" duration="${durSec}s" start="${inSec}s">\n`;
    if (c.speed !== 1) {
      xml += `              <time-map>\n`;
      xml += `                <timept time="0s" value="0s" interp="linear"/>\n`;
      xml += `                <timept time="${durSec}s" value="${(parseFloat(durSec) * c.speed).toFixed(2)}s" interp="linear"/>\n`;
      xml += `              </time-map>\n`;
    }
    xml += `            </clip>\n`;
  });

  xml += `          </spine>\n`;
  xml += `        </sequence>\n`;
  xml += `      </project>\n`;
  xml += `    </event>\n`;
  xml += `  </library>\n`;
  xml += `</fcpxml>\n`;

  return xml;
}

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
