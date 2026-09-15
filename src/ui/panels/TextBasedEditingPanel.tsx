import React, { useState } from 'react';
import { useActiveSequence, useProject } from '../../state/projectStore';
import { useUI } from '../../state/uiStore';
import { usePlayback } from '../../engine/playback/playback';
import { Button, IconButton, TextField } from '../controls';
import { Icon } from '../icons';
import * as E from '../../engine/timeline/edits';

export function TextBasedEditingPanel() {
  const seq = useActiveSequence();
  const ui = useUI();
  const setPlayhead = usePlayback((s) => s.setPlayhead);
  const playhead = usePlayback((s) => s.playhead);

  const [search, setSearch] = useState('');
  const [selectedWordIndices, setSelectedWordIndices] = useState<number[]>([]);

  if (!seq) {
    return (
      <div className="empty" style={{ padding: 16 }}>
        <Icon name="transcript" size={28} />
        <div style={{ marginTop: 8 }}>No active sequence</div>
      </div>
    );
  }

  const fps = seq.settings.fps;
  // Use transcript if present, otherwise build from captions
  const words = seq.transcript?.words ?? seq.captions.flatMap((c) => c.words ?? []);
  const hasWords = words.length > 0;

  const toggleWordSelect = (idx: number, e: React.MouseEvent) => {
    if (e.shiftKey && selectedWordIndices.length > 0) {
      const last = selectedWordIndices[selectedWordIndices.length - 1];
      const start = Math.min(last, idx);
      const end = Math.max(last, idx);
      const range = Array.from({ length: end - start + 1 }, (_, i) => start + i);
      setSelectedWordIndices(Array.from(new Set([...selectedWordIndices, ...range])));
    } else if (e.ctrlKey || e.metaKey) {
      if (selectedWordIndices.includes(idx)) {
        setSelectedWordIndices(selectedWordIndices.filter((i) => i !== idx));
      } else {
        setSelectedWordIndices([...selectedWordIndices, idx]);
      }
    } else {
      setSelectedWordIndices([idx]);
      setPlayhead(words[idx].t0);
    }
  };

  const rippleDeleteSelection = () => {
    if (!selectedWordIndices.length) return;
    const selectedWords = selectedWordIndices.map((i) => words[i]).filter(Boolean);
    if (!selectedWords.length) return;

    const minFrame = Math.min(...selectedWords.map((w) => w.t0));
    const maxFrame = Math.max(...selectedWords.map((w) => w.t1));

    useProject.getState().update('Text-Based Edit (Ripple Delete)', (p) => {
      const s = p.sequences.find((x) => x.id === seq.id);
      if (!s) return;

      // Extract / ripple delete range from targeted tracks
      const v1 = s.tracks.find((t) => t.kind === 'video' && t.targeted) || s.tracks.find((t) => t.kind === 'video');
      const a1 = s.tracks.find((t) => t.kind === 'audio' && t.targeted) || s.tracks.find((t) => t.kind === 'audio');
      const targetTrackIds = [v1?.id, a1?.id].filter(Boolean) as string[];

      E.liftRange(s, minFrame, maxFrame, true, targetTrackIds);
    });

    setSelectedWordIndices([]);
    ui.toast({ kind: 'info', title: 'Text Edit', message: `Ripple deleted frames ${minFrame} to ${maxFrame}.` });
  };

  const filteredWords = words.map((w, idx) => ({ word: w, idx })).filter((item) => !search.trim() || item.word.text.toLowerCase().includes(search.toLowerCase()));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: 10, gap: 10, background: 'var(--c-bg-panel)', color: 'var(--c-text)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Icon name="transcript" />
        <strong style={{ fontSize: 13 }}>Text-Based Editing</strong>
        <span className="spacer" />
        {!hasWords ? (
          <Button sm primary onClick={() => ui.openModal({ kind: 'transcribe' })}>
            Transcribe Sequence...
          </Button>
        ) : null}
      </div>

      {hasWords ? (
        <>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <TextField placeholder="Search transcript..." value={search} onChange={(e) => setSearch(e.target.value)} style={{ flex: 1 }} />
            {selectedWordIndices.length > 0 ? (
              <Button sm danger onClick={rippleDeleteSelection}>
                Ripple Delete Selection ({selectedWordIndices.length} words)
              </Button>
            ) : null}
          </div>

          <div
            style={{
              flex: 1,
              overflowY: 'auto',
              background: 'var(--c-bg-input)',
              border: '1px solid var(--c-border)',
              borderRadius: 4,
              padding: 10,
              lineHeight: 1.8,
              fontSize: 13,
              userSelect: 'none',
            }}
          >
            {filteredWords.map(({ word, idx }) => {
              const active = playhead >= word.t0 && playhead < word.t1;
              const selected = selectedWordIndices.includes(idx);
              const sec = (word.t0 / fps).toFixed(1);

              return (
                <span
                  key={idx}
                  onClick={(e) => toggleWordSelect(idx, e)}
                  title={`${sec}s (${word.t0}f)`}
                  style={{
                    display: 'inline-block',
                    padding: '1px 4px',
                    margin: '1px 2px',
                    borderRadius: 3,
                    cursor: 'pointer',
                    background: selected ? 'var(--c-accent)' : active ? 'rgba(255,213,74,0.3)' : 'transparent',
                    color: selected ? '#fff' : active ? '#ffd54a' : 'inherit',
                    fontWeight: active || selected ? 600 : 400,
                  }}
                >
                  {word.text}
                </span>
              );
            })}
          </div>

          <div style={{ fontSize: 11, color: 'var(--c-text-dim)' }}>
            Click words to jump playhead. Drag or Shift/Ctrl+Click to select text, then click Ripple Delete to edit the timeline video.
          </div>
        </>
      ) : (
        <div className="empty" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="transcribe" size={32} />
          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--c-text-dim)', textAlign: 'center' }}>
            Transcribe sequence speech with Whisper AI to enable text-based video editing.
          </div>
          <Button primary style={{ marginTop: 12 }} onClick={() => ui.openModal({ kind: 'transcribe' })}>
            Transcribe Sequence
          </Button>
        </div>
      )}
    </div>
  );
}
