import React from 'react';
import { useActiveSequence, useProject } from '../../state/projectStore';
import { useUI } from '../../state/uiStore';
import { usePlayback } from '../../engine/playback/playback';
import { Button, IconButton } from '../controls';
import { Icon } from '../icons';
import { switchMulticamAngle, getActiveAngleAtFrame } from '../../engine/timeline/multicam';

export function MulticamPanel() {
  const seq = useActiveSequence();
  const project = useProject((s) => s.project);
  const playhead = usePlayback((s) => s.playhead);
  const playing = usePlayback((s) => s.playing);

  if (!seq || !seq.multicam) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', padding: 16, background: 'var(--c-bg-panel)', color: 'var(--c-text)' }}>
        <Icon name="multicam" size={32} />
        <div style={{ marginTop: 10, fontSize: 13, fontWeight: 500 }}>Multicam Editing</div>
        <div style={{ marginTop: 4, fontSize: 11, color: 'var(--c-text-dim)', textAlign: 'center', maxWidth: 280 }}>
          No multicam sequence is active. Select multiple media clips in the Project Panel to build a synced multi-angle camera sequence.
        </div>
      </div>
    );
  }

  const mc = seq.multicam;
  const activeAngle = getActiveAngleAtFrame(mc, playhead);

  const handleAngleCut = (angleId: string) => {
    switchMulticamAngle(seq.id, angleId, playhead);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: 10, gap: 10, background: 'var(--c-bg-panel)', color: 'var(--c-text)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Icon name="multicam" />
        <strong style={{ fontSize: 13 }}>Multicam Switcher ({mc.angles.length} Angles)</strong>
        <span className="spacer" />
        <span style={{ fontSize: 11, color: 'var(--c-text-dim)' }}>
          Active: <strong style={{ color: 'var(--c-accent)' }}>{activeAngle?.name ?? 'Angle 1'}</strong>
        </span>
      </div>

      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: mc.angles.length <= 2 ? '1fr 1fr' : '1fr 1fr', gap: 8, overflowY: 'auto' }}>
        {mc.angles.map((angle, idx) => {
          const isActive = activeAngle?.id === angle.id;
          const keyNum = idx + 1;

          return (
            <div
              key={angle.id}
              onClick={() => handleAngleCut(angle.id)}
              style={{
                position: 'relative',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                padding: 10,
                borderRadius: 6,
                border: isActive ? '2px solid var(--c-accent)' : '1px solid var(--c-border)',
                background: isActive ? 'rgba(61,123,217,0.15)' : 'var(--c-bg-input)',
                cursor: 'pointer',
                userSelect: 'none',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 12, fontWeight: 600 }}>{angle.name}</span>
                <span style={{ fontSize: 10, background: isActive ? 'var(--c-accent)' : 'var(--c-bg-panel)', color: isActive ? '#fff' : 'var(--c-text-dim)', padding: '2px 6px', borderRadius: 3 }}>
                  [{keyNum}]
                </span>
              </div>

              <div style={{ marginTop: 20, textAlign: 'center', fontSize: 11, color: isActive ? 'var(--c-accent)' : 'var(--c-text-dim)' }}>
                {isActive ? '● LIVE ANGLE' : 'Click or press ' + keyNum + ' to cut'}
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ fontSize: 11, color: 'var(--c-text-dim)' }}>
        Tip: Press keys 1-{mc.angles.length} during playback to record real-time multicam cuts on the timeline.
      </div>
    </div>
  );
}
