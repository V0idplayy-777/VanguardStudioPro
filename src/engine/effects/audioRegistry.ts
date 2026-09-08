import type { EffectDef, ParamDef } from './registry';

/*
  Audio effects. Each maps to a Web Audio node chain built by engine/audio/graph.ts.
  Parameters are described with the same ParamDef schema as video effects so the
  Effect Controls panel is uniform. The `passes` array is unused for audio.
*/

const n = (key: string, label: string, d: number, min: number, max: number, step = 0.1, extra: Partial<ParamDef> = {}): ParamDef => ({
  key,
  label,
  kind: 'number',
  default: d,
  min,
  max,
  step,
  ...extra,
});
const b = (key: string, label: string, d: boolean): ParamDef => ({ key, label, kind: 'bool', default: d });
const sel = (key: string, label: string, d: number, options: { value: number; label: string }[]): ParamDef => ({ key, label, kind: 'select', default: d, options });

function adef(type: string, name: string, category: EffectDef['category'], description: string, params: ParamDef[], presets?: EffectDef['presets']): EffectDef {
  return { type, name, category, description, params, passes: [], audio: true, keyframable: true, presets };
}

export const AUDIO_EFFECTS: EffectDef[] = [
  adef(
    'aParametricEq',
    'Parametric Equalizer',
    'Audio: EQ',
    'Five-band parametric EQ with low/high shelves and three peaking bands.',
    [
      n('lowFreq', 'Low Shelf Freq', 100, 20, 1000, 1, { unit: 'Hz', group: 'Low Shelf' }),
      n('lowGain', 'Low Shelf Gain', 0, -24, 24, 0.1, { unit: 'dB', group: 'Low Shelf' }),
      n('b1Freq', 'Band 1 Freq', 250, 20, 20000, 1, { unit: 'Hz', group: 'Band 1' }),
      n('b1Gain', 'Band 1 Gain', 0, -24, 24, 0.1, { unit: 'dB', group: 'Band 1' }),
      n('b1Q', 'Band 1 Q', 1, 0.1, 20, 0.05, { group: 'Band 1' }),
      n('b2Freq', 'Band 2 Freq', 1000, 20, 20000, 1, { unit: 'Hz', group: 'Band 2' }),
      n('b2Gain', 'Band 2 Gain', 0, -24, 24, 0.1, { unit: 'dB', group: 'Band 2' }),
      n('b2Q', 'Band 2 Q', 1, 0.1, 20, 0.05, { group: 'Band 2' }),
      n('b3Freq', 'Band 3 Freq', 4000, 20, 20000, 1, { unit: 'Hz', group: 'Band 3' }),
      n('b3Gain', 'Band 3 Gain', 0, -24, 24, 0.1, { unit: 'dB', group: 'Band 3' }),
      n('b3Q', 'Band 3 Q', 1, 0.1, 20, 0.05, { group: 'Band 3' }),
      n('highFreq', 'High Shelf Freq', 8000, 1000, 20000, 1, { unit: 'Hz', group: 'High Shelf' }),
      n('highGain', 'High Shelf Gain', 0, -24, 24, 0.1, { unit: 'dB', group: 'High Shelf' }),
      n('output', 'Output Gain', 0, -24, 24, 0.1, { unit: 'dB' }),
    ],
    [
      { name: 'Vocal Presence', values: { b2Freq: 3000, b2Gain: 3, b2Q: 1.2, lowFreq: 120, lowGain: -3 } },
      { name: 'Telephone', values: { lowFreq: 400, lowGain: -24, highFreq: 3400, highGain: -24, b2Freq: 1500, b2Gain: 6, b2Q: 0.8 } },
      { name: 'Warmth', values: { lowFreq: 200, lowGain: 3, highFreq: 10000, highGain: -2 } },
      { name: 'Air', values: { highFreq: 12000, highGain: 4 } },
    ],
  ),
  adef(
    'aHighPass',
    'Highpass',
    'Audio: EQ',
    'Remove low frequencies below the cutoff.',
    [n('cutoff', 'Cutoff', 80, 20, 5000, 1, { unit: 'Hz' }), n('q', 'Resonance', 0.7, 0.1, 10, 0.05)],
  ),
  adef(
    'aLowPass',
    'Lowpass',
    'Audio: EQ',
    'Remove high frequencies above the cutoff.',
    [n('cutoff', 'Cutoff', 8000, 100, 20000, 1, { unit: 'Hz' }), n('q', 'Resonance', 0.7, 0.1, 10, 0.05)],
  ),
  adef(
    'aBandPass',
    'Bandpass',
    'Audio: EQ',
    'Isolate a band of frequencies.',
    [n('center', 'Center', 1000, 20, 20000, 1, { unit: 'Hz' }), n('q', 'Q', 1, 0.1, 20, 0.05)],
  ),
  adef(
    'aNotch',
    'Notch',
    'Audio: EQ',
    'Cut a narrow band, e.g. mains hum.',
    [n('center', 'Center', 60, 20, 20000, 1, { unit: 'Hz' }), n('q', 'Q', 10, 0.1, 50, 0.1)],
    [
      { name: '50 Hz Hum', values: { center: 50, q: 20 } },
      { name: '60 Hz Hum', values: { center: 60, q: 20 } },
    ],
  ),
  adef(
    'aBassTreble',
    'Bass / Treble',
    'Audio: EQ',
    'Simple tone control.',
    [n('bass', 'Bass', 0, -24, 24, 0.1, { unit: 'dB' }), n('treble', 'Treble', 0, -24, 24, 0.1, { unit: 'dB' })],
  ),
  adef(
    'aCompressor',
    'Compressor',
    'Audio: Dynamics',
    'Dynamic range compression with makeup gain.',
    [
      n('threshold', 'Threshold', -18, -60, 0, 0.5, { unit: 'dB' }),
      n('ratio', 'Ratio', 3, 1, 20, 0.1),
      n('knee', 'Knee', 6, 0, 40, 0.5, { unit: 'dB' }),
      n('attack', 'Attack', 10, 0, 500, 1, { unit: 'ms' }),
      n('release', 'Release', 120, 10, 2000, 1, { unit: 'ms' }),
      n('makeup', 'Makeup Gain', 0, 0, 24, 0.1, { unit: 'dB' }),
    ],
    [
      { name: 'Vocal Leveler', values: { threshold: -20, ratio: 3, attack: 8, release: 150, makeup: 4 } },
      { name: 'Drum Smash', values: { threshold: -30, ratio: 10, attack: 2, release: 60, makeup: 8 } },
      { name: 'Gentle Glue', values: { threshold: -12, ratio: 1.8, attack: 30, release: 300, makeup: 1.5 } },
    ],
  ),
  adef(
    'aLimiter',
    'Hard Limiter',
    'Audio: Dynamics',
    'Brick-wall peak limiter.',
    [n('ceiling', 'Ceiling', -1, -20, 0, 0.1, { unit: 'dB' }), n('release', 'Release', 50, 5, 1000, 1, { unit: 'ms' }), n('inputBoost', 'Input Boost', 0, 0, 24, 0.1, { unit: 'dB' })],
  ),
  adef(
    'aGate',
    'Noise Gate',
    'Audio: Dynamics',
    'Silence audio below a threshold.',
    [n('threshold', 'Threshold', -40, -80, 0, 0.5, { unit: 'dB' }), n('attack', 'Attack', 5, 0, 200, 1, { unit: 'ms' }), n('release', 'Release', 100, 5, 2000, 1, { unit: 'ms' }), n('range', 'Range', -60, -80, 0, 0.5, { unit: 'dB' })],
  ),
  adef(
    'aExpander',
    'Expander',
    'Audio: Dynamics',
    'Downward expansion for quieter noise floors.',
    [n('threshold', 'Threshold', -35, -80, 0, 0.5, { unit: 'dB' }), n('ratio', 'Ratio', 2, 1, 10, 0.1), n('attack', 'Attack', 5, 0, 200, 1, { unit: 'ms' }), n('release', 'Release', 150, 5, 2000, 1, { unit: 'ms' })],
  ),
  adef(
    'aDeEsser',
    'De-Esser',
    'Audio: Dynamics',
    'Tame sibilance around 4-9 kHz.',
    [n('frequency', 'Frequency', 6500, 2000, 12000, 10, { unit: 'Hz' }), n('threshold', 'Threshold', -25, -60, 0, 0.5, { unit: 'dB' }), n('amount', 'Reduction', 6, 0, 24, 0.5, { unit: 'dB' })],
  ),
  adef(
    'aReverb',
    'Studio Reverb',
    'Audio: Reverb & Delay',
    'Algorithmic convolution reverb with room presets.',
    [
      sel('room', 'Room', 1, [
        { value: 0, label: 'Small Room' },
        { value: 1, label: 'Medium Hall' },
        { value: 2, label: 'Large Hall' },
        { value: 3, label: 'Cathedral' },
        { value: 4, label: 'Plate' },
        { value: 5, label: 'Spring' },
      ]),
      n('decay', 'Decay', 1.8, 0.1, 10, 0.05, { unit: 's' }),
      n('preDelay', 'Pre-Delay', 20, 0, 200, 1, { unit: 'ms' }),
      n('damping', 'HF Damping', 40, 0, 100, 0.5, { unit: '%' }),
      n('mix', 'Mix', 25, 0, 100, 0.5, { unit: '%' }),
    ],
  ),
  adef(
    'aDelay',
    'Analog Delay',
    'Audio: Reverb & Delay',
    'Feedback delay with tone shaping and ping-pong.',
    [n('time', 'Delay Time', 350, 1, 3000, 1, { unit: 'ms' }), n('feedback', 'Feedback', 35, 0, 95, 0.5, { unit: '%' }), n('tone', 'Tone', 4000, 200, 20000, 10, { unit: 'Hz' }), n('mix', 'Mix', 30, 0, 100, 0.5, { unit: '%' }), b('pingPong', 'Ping-Pong', false)],
    [
      { name: 'Slapback', values: { time: 90, feedback: 10, mix: 25 } },
      { name: 'Dub Echo', values: { time: 420, feedback: 65, tone: 1800, mix: 40, pingPong: true } },
    ],
  ),
  adef(
    'aChorus',
    'Chorus',
    'Audio: Modulation',
    'Modulated short delay for thickening.',
    [n('rate', 'Rate', 0.8, 0.05, 10, 0.01, { unit: 'Hz' }), n('depth', 'Depth', 4, 0, 20, 0.1, { unit: 'ms' }), n('delay', 'Base Delay', 20, 5, 50, 0.5, { unit: 'ms' }), n('mix', 'Mix', 40, 0, 100, 0.5, { unit: '%' })],
  ),
  adef(
    'aFlanger',
    'Flanger',
    'Audio: Modulation',
    'Short swept delay with feedback.',
    [n('rate', 'Rate', 0.3, 0.05, 10, 0.01, { unit: 'Hz' }), n('depth', 'Depth', 2, 0, 10, 0.05, { unit: 'ms' }), n('feedback', 'Feedback', 40, 0, 95, 0.5, { unit: '%' }), n('mix', 'Mix', 50, 0, 100, 0.5, { unit: '%' })],
  ),
  adef(
    'aPhaser',
    'Phaser',
    'Audio: Modulation',
    'Swept all-pass stages.',
    [n('rate', 'Rate', 0.5, 0.05, 10, 0.01, { unit: 'Hz' }), n('depth', 'Depth', 60, 0, 100, 0.5, { unit: '%' }), n('stages', 'Stages', 4, 2, 8, 2), n('mix', 'Mix', 50, 0, 100, 0.5, { unit: '%' })],
  ),
  adef(
    'aTremolo',
    'Tremolo',
    'Audio: Modulation',
    'Amplitude modulation.',
    [n('rate', 'Rate', 5, 0.1, 30, 0.05, { unit: 'Hz' }), n('depth', 'Depth', 50, 0, 100, 0.5, { unit: '%' })],
  ),
  adef(
    'aDistortion',
    'Distortion',
    'Audio: Modulation',
    'Waveshaping overdrive.',
    [
      n('drive', 'Drive', 20, 0, 100, 0.5, { unit: '%' }),
      sel('type', 'Type', 0, [
        { value: 0, label: 'Soft Clip' },
        { value: 1, label: 'Hard Clip' },
        { value: 2, label: 'Fuzz' },
        { value: 3, label: 'Bitcrush' },
      ]),
      n('tone', 'Tone', 6000, 500, 20000, 10, { unit: 'Hz' }),
      n('mix', 'Mix', 100, 0, 100, 0.5, { unit: '%' }),
    ],
  ),
  adef(
    'aPitchShift',
    'Pitch Shifter',
    'Audio: Modulation',
    'Granular pitch shift in semitones.',
    [n('semitones', 'Semitones', 0, -24, 24, 0.01), n('mix', 'Mix', 100, 0, 100, 0.5, { unit: '%' })],
  ),
  adef(
    'aStereoWidth',
    'Stereo Width',
    'Audio: Utility',
    'Mid/side width control.',
    [n('width', 'Width', 100, 0, 200, 0.5, { unit: '%' })],
  ),
  adef(
    'aChannelVolume',
    'Channel Volume',
    'Audio: Utility',
    'Independent left and right gain.',
    [n('left', 'Left', 0, -96, 15, 0.1, { unit: 'dB' }), n('right', 'Right', 0, -96, 15, 0.1, { unit: 'dB' })],
  ),
  adef(
    'aFillLeft',
    'Fill Left with Right',
    'Audio: Utility',
    'Duplicate the right channel into the left.',
    [],
  ),
  adef(
    'aFillRight',
    'Fill Right with Left',
    'Audio: Utility',
    'Duplicate the left channel into the right.',
    [],
  ),
  adef('aSwapChannels', 'Swap Channels', 'Audio: Utility', 'Swap left and right.', []),
  adef('aInvert', 'Invert Phase', 'Audio: Utility', 'Flip polarity.', []),
  adef(
    'aDcOffset',
    'DC Offset Removal',
    'Audio: Utility',
    'Remove sub-sonic bias with a gentle highpass.',
    [n('cutoff', 'Cutoff', 20, 5, 60, 1, { unit: 'Hz' })],
  ),
  adef(
    'aNoiseReduction',
    'Adaptive Noise Reduction',
    'Audio: Dynamics',
    'Spectral-style broadband denoise using a multiband expander.',
    [n('amount', 'Reduction', 12, 0, 40, 0.5, { unit: 'dB' }), n('threshold', 'Noise Floor', -50, -90, -20, 0.5, { unit: 'dB' }), n('smoothing', 'Smoothing', 50, 0, 100, 0.5, { unit: '%' })],
  ),
  adef(
    'aLoudnessNormalize',
    'Loudness Normalize',
    'Audio: Dynamics',
    'Target integrated loudness for broadcast delivery.',
    [
      sel('standard', 'Standard', 0, [
        { value: 0, label: 'EBU R128 (-23 LUFS)' },
        { value: 1, label: 'ATSC A/85 (-24 LKFS)' },
        { value: 2, label: 'Streaming (-14 LUFS)' },
        { value: 3, label: 'Podcast (-16 LUFS)' },
      ]),
      n('truePeak', 'True Peak Ceiling', -1, -9, 0, 0.1, { unit: 'dBTP' }),
    ],
  ),
  adef(
    'aHumRemove',
    'Hum Remover',
    'Audio: EQ',
    'Notch bank for mains hum: removes the fundamental plus harmonics in one insert.',
    [
      sel('frequency', 'Mains Frequency', 1, [
        { value: 0, label: '50 Hz (EU / Asia)' },
        { value: 1, label: '60 Hz (Americas)' },
      ]),
      n('harmonics', 'Harmonics', 4, 1, 6, 1),
      n('q', 'Notch Width (Q)', 18, 2, 60, 0.5),
      n('mix', 'Mix', 100, 0, 100, 0.5, { unit: '%' }),
    ],
    [
      { name: '50 Hz Studio', values: { frequency: 0, harmonics: 4, q: 18 } },
      { name: '60 Hz Location', values: { frequency: 1, harmonics: 5, q: 14 } },
    ],
  ),
  adef(
    'aVoiceLeveler',
    'Voice Leveler',
    'Audio: Dynamics',
    'Slow speech-optimized auto-gain that evens out dialogue, with a safety ceiling.',
    [
      n('target', 'Target Level', -20, -40, -6, 0.5, { unit: 'dB' }),
      n('strength', 'Strength', 60, 0, 100, 1, { unit: '%' }),
      n('maxGain', 'Max Gain', 10, 0, 24, 0.5, { unit: 'dB' }),
      n('ceiling', 'Ceiling', -1.5, -12, 0, 0.1, { unit: 'dB' }),
    ],
    [
      { name: 'Podcast', values: { target: -20, strength: 65, maxGain: 12 } },
      { name: 'Gentle', values: { target: -23, strength: 35, maxGain: 6 } },
    ],
  ),
  adef(
    'aRoomTone',
    'Room Tone Reducer',
    'Audio: Dynamics',
    'Soft downward expansion that pushes room tone and reverb tails down between words.',
    [
      n('amount', 'Reduction', 50, 0, 100, 1, { unit: '%' }),
      n('threshold', 'Threshold', -42, -80, -12, 0.5, { unit: 'dB' }),
      n('softness', 'Soft Knee', 60, 0, 100, 1, { unit: '%' }),
      n('mix', 'Mix', 100, 0, 100, 0.5, { unit: '%' }),
    ],
  ),
  adef(
    'aVoiceDenoise',
    'Voice Denoise (Realtime)',
    'Audio: Dynamics',
    'Dynamic high-frequency hiss filter for dialogue. For heavy noise, bake the full cleanup from Clip > Clean Up Voice.',
    [
      n('amount', 'Reduction', 50, 0, 100, 1, { unit: '%' }),
      n('threshold', 'Threshold', -48, -80, -12, 0.5, { unit: 'dB' }),
      n('hissFreq', 'Hiss Above', 5000, 2000, 12000, 50, { unit: 'Hz' }),
      n('mix', 'Mix', 100, 0, 100, 0.5, { unit: '%' }),
    ],
  ),
];

export const AUDIO_EFFECT_MAP: Record<string, EffectDef> = Object.fromEntries(AUDIO_EFFECTS.map((e) => [e.type, e]));
