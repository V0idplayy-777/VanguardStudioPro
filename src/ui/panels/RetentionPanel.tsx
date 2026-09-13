import React, { useMemo } from 'react';
import { useActiveSequence } from '../../state/projectStore';
import { Button, Empty } from '../controls';
import { Icon } from '../icons';
import { retentionCmd } from '../../app/retention';
import { analyzeRetention, type RetentionFinding } from '../../retention/analyze';

const STATUS: Record<RetentionFinding['status'], { icon: string; color: string }> = {
  ok: { icon: 'check', color: 'var(--c-ok, #4da58a)' },
  warn: { icon: 'warning', color: 'var(--c-warn, #c48a3e)' },
  info: { icon: 'info', color: 'var(--c-text-dim)' },
};

function runFix(fix?: RetentionFinding['fix']) {
  if (!fix) return;
  switch (fix) {
    case 'smartCaptions': retentionCmd.openSmartCaptions(); break;
    case 'retentionCaptionStyle': retentionCmd.applyRetentionCaptionStyle(); break;
    case 'zoomPunches': retentionCmd.zoomPunches(); break;
    case 'flashOnCuts': retentionCmd.flashOnCuts(); break;
    case 'musicBed': retentionCmd.applyMusicBed(); break;
    case 'loopOutro': retentionCmd.openLoopOutro(); break;
    case 'rewindTrap': retentionCmd.openRewindTrap(); break;
    case 'typoBait': retentionCmd.plantTypoBait(); break;
  }
}

export function RetentionPanel() {
  const seq = useActiveSequence();
  const report = useMemo(() => (seq ? analyzeRetention(seq) : null), [seq]);

  if (!seq) {
    return (
      <Empty title="Retention" icon="target">
        Open a sequence to score it against the Corporate Retention &amp; Engagement Playbook.
      </Empty>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="scroll-y" style={{ flex: 1, padding: 8 }}>
        <div className="settings-section-title" style={{ marginTop: 2 }}>One-click tools</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
          <Button sm onClick={() => retentionCmd.openSmartCaptions()}>Smart Captions…</Button>
          <Button sm onClick={() => retentionCmd.applyRetentionCaptionStyle()}>Caption Style</Button>
          <Button sm onClick={() => retentionCmd.zoomPunches()}>Zoom Punches</Button>
          <Button sm onClick={() => retentionCmd.flashOnCuts()}>Flash on Cuts</Button>
          <Button sm onClick={() => retentionCmd.openRewindTrap()}>Rewind Trap…</Button>
          <Button sm onClick={() => retentionCmd.plantTypoBait()}>Comment Bait</Button>
          <Button sm onClick={() => retentionCmd.applyMusicBed()}>Music Bed 5%</Button>
          <Button sm onClick={() => retentionCmd.openDopamine()}>Dopamine SFX…</Button>
          <Button sm onClick={() => retentionCmd.openLoopOutro()}>Loop Outro…</Button>
          <Button sm onClick={() => retentionCmd.openBrandKit()}>Brand Kit…</Button>
        </div>

        <div className="settings-section-title" style={{ marginTop: 10 }}>Playbook score</div>
        {report!.findings.length === 0 ? <div className="dim" style={{ fontSize: 11 }}>No findings.</div> : null}
        {report!.findings.map((f) => (
          <div key={f.id} style={{ display: 'flex', gap: 8, padding: '5px 2px', borderBottom: '1px solid var(--c-line)', alignItems: 'flex-start' }}>
            <Icon name={STATUS[f.status].icon as any} size={13} style={{ color: STATUS[f.status].color, marginTop: 1, flex: '0 0 auto' }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <strong style={{ fontSize: 12 }}>{f.title}</strong>
              <div style={{ fontSize: 11, color: 'var(--c-text-dim)' }}>{f.detail}</div>
            </div>
            {f.fix ? <Button sm onClick={() => runFix(f.fix)}>Fix</Button> : null}
          </div>
        ))}
      </div>

      <div style={{ padding: '6px 8px', borderTop: '1px solid var(--c-line)', fontSize: 10, color: 'var(--c-text-dim)' }}>
        Retention Toolkit - every action is one undo step.
      </div>
    </div>
  );
}
