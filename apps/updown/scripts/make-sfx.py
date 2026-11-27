"""Synthesise the Up Down sound effects (no downloads, nothing to license).

    python -I scripts/make-sfx.py            -> public/sfx/<name>.ogg + .mp3 (ffmpeg on PATH)
    python -I scripts/make-sfx.py --wav      -> public/sfx/<name>.wav only (no ffmpeg needed)
    python -I scripts/make-sfx.py --check    -> render only, print the sanity report (peak, RMS, DC, tail, clipping)

The sounds are designed, not beeped: every voice is a stack of slightly detuned partials with an exponential ADSR,
the set shares one key (A major / its relative C major cousins), chords and short arpeggios replace single sines, and
each render goes through a gentle low-pass, soft saturation and a small Schroeder reverb (combs + allpasses) before a
true-peak-safe normalisation and a fade-out. 44.1 kHz mono. Peaks: -12 dBFS for the payouts and the fill, -16 for
the rest.
"""
import argparse, shutil, subprocess, sys, tempfile, wave
from pathlib import Path

import numpy as np
from scipy.signal import lfilter

SR = 44100
rng = np.random.default_rng(7)
OUT = Path(__file__).resolve().parent.parent / 'public' / 'sfx'

LOUD = -12.0   # dBFS, win / win-big / filled
SOFT = -16.0   # dBFS, everything else


def dbfs(db): return 10 ** (db / 20)
def tt(d): return np.arange(int(SR * d)) / SR
def hz(n): return 440 * 2 ** ((n - 69) / 12)


# ---------- filters / effects ----------
def lowpass(x, fc, order=1):
    """One-pole low-pass (vectorised); `order` stages for a steeper slope."""
    a = 1 - np.exp(-2 * np.pi * fc / SR)
    for _ in range(order): x = lfilter([a], [1, a - 1], x)
    return x


def highpass(x, fc): return x - lowpass(x, fc)


def saturate(x, drive=1.5):
    """Soft clip (tanh), normalised so a quiet signal passes at unity."""
    return np.tanh(x * drive) / np.tanh(drive)


def comb(x, delay_s, feedback, damp=.2):
    """Feedback comb with a one-pole damping filter in the loop (the Schroeder / Freeverb comb)."""
    # H(z) = z^-d (1 - damp z^-1) / ((1 - damp z^-1) - feedback (1 - damp) z^-d), as one IIR filter
    d = max(2, int(delay_s * SR))
    b = np.zeros(d + 2); b[d] = 1; b[d + 1] = -damp
    a = np.zeros(d + 1); a[0] = 1; a[1] = -damp; a[d] -= feedback * (1 - damp)
    return lfilter(b, a, x)


def allpass(x, delay_s, g=.5):
    d = max(1, int(delay_s * SR)); b = np.zeros(d + 1); a = np.zeros(d + 1)
    b[0] = -g; b[d] = 1; a[0] = 1; a[d] = -g
    return lfilter(b, a, x)


def reverb(x, mix=.25, size=1.0, decay=.78, damp=.25, tail=.6):
    """A small Schroeder reverb: four parallel combs into two series allpasses, mixed with the dry signal.
    `tail` seconds are appended so the reverb can ring past the dry sound."""
    x = np.concatenate([x, np.zeros(int(SR * tail))])
    delays = np.array([.0297, .0371, .0411, .0437]) * size
    wet = sum(comb(x, d, decay, damp) for d in delays) / len(delays)
    wet = allpass(allpass(wet, .005 * size, .5), .0017 * size, .5)
    wet = lowpass(wet, 6000)
    return x * (1 - mix) + wet * mix


def adsr(n, a=.005, d=.08, s=.5, r=.15, curve=4.0):
    """Exponential ADSR over `n` samples: attack to 1, decay to `s`, hold, release to 0 (lengths in seconds)."""
    a_n, d_n, r_n = (max(1, int(SR * v)) for v in (a, d, r))
    s_n = max(0, n - a_n - d_n - r_n)
    if s_n == 0:  # too short for the full shape: shrink the release
        r_n = max(1, n - a_n - d_n); s_n = 0
    k = np.linspace(0, 1, a_n); att = 1 - np.exp(-k * curve); att /= att[-1]
    k = np.linspace(0, 1, d_n); dec = s + (1 - s) * (np.exp(-k * curve) - np.exp(-curve)) / (1 - np.exp(-curve))
    k = np.linspace(0, 1, r_n); rel = s * (np.exp(-k * curve) - np.exp(-curve)) / (1 - np.exp(-curve))
    env = np.concatenate([att, dec, np.full(s_n, s), rel])
    return env[:n] if len(env) >= n else np.pad(env, (0, n - len(env)))


def put(buf, t, snd, gain=1.0):
    s = int(round(t * SR)); e = min(len(buf), s + len(snd))
    if e > s: buf[s:e] += snd[:e - s] * gain
    return buf


def mix(d, *parts):
    """parts: (time, sound, gain) into a buffer of `d` seconds."""
    buf = np.zeros(int(SR * d))
    for t, snd, g in parts: put(buf, t, snd, g)
    return buf


def fade_out(x, d=.04):
    n = min(len(x), int(SR * d)); x[-n:] *= np.cos(np.linspace(0, np.pi / 2, n)) ** 2; return x


def finish(x, peak_db, lp=9000, drive=1.3, fade=.06):
    """Master chain: DC removal, gentle low-pass, soft saturation, true-peak-safe normalise, fade-out."""
    x = x - np.mean(x)
    x = lowpass(x, lp)
    x = saturate(x / (np.max(np.abs(x)) or 1) * .9, drive)
    x = highpass(x, 25)
    # true peak: check a 4x oversampled version and scale so the inter-sample peak sits at the target
    over = np.interp(np.arange(len(x) * 4) / 4, np.arange(len(x)), x)
    x = x / (max(np.max(np.abs(over)), np.max(np.abs(x))) or 1) * dbfs(peak_db)
    return fade_out(x, fade)


# ---------- voices ----------
def tone(f, d, partials=((1, 1.0), (2, .35), (3, .15), (4, .07)), detune=.004, env=(.004, .1, .35, .3), bright=1.0, phase_rand=True):
    """A layered partial stack: each partial is three slightly detuned sines (chorus-like width), higher partials
    decay faster, the whole thing under an exponential ADSR."""
    t = tt(d); x = np.zeros(len(t)); a, dcy, s, r = env
    for k, amp in partials:
        for det in (-detune, 0, detune):
            ph = rng.uniform(0, 2 * np.pi) if phase_rand else 0
            x += amp * np.sin(2 * np.pi * f * k * (1 + det) * t + ph) * np.exp(-t * (k - 1) * 3 / bright)
    return x / 3 * adsr(len(t), a, dcy, s, r)


def bell(f, d, decay=6.0, shimmer=1.0):
    """A metallic, coin-like strike: inharmonic partials (bell ratios), the high ones dying fastest, with a
    short noise transient for the strike."""
    t = tt(d)
    ratios = ((1, 1.0, 1.0), (2.0, .55, 1.4), (2.76, .35, 2.0), (3.57, .22, 2.6), (4.07, .14, 3.2), (5.4, .08 * shimmer, 4.0))
    x = sum(a * np.sin(2 * np.pi * f * r * (1 + rng.uniform(-.002, .002)) * t) * np.exp(-t * decay * sp) for r, a, sp in ratios)
    strike = highpass(rng.normal(0, 1, len(t)), 3000) * np.exp(-t * 700) * .35
    return (x * np.minimum(1, t / .0015) + strike) * .5


def chord(notes, d, gain=1.0, **kw):
    x = np.zeros(int(SR * d))
    for n in notes: x += tone(hz(n), d, **kw)
    return x / max(1, len(notes)) ** .5 * gain


def arpeggio(notes, gap, d, voice=tone, gains=None, **kw):
    """Notes one after another, each ringing for `d` seconds; total length d + gap * (len - 1)."""
    x = np.zeros(int(SR * (d + gap * (len(notes) - 1))))
    for i, n in enumerate(notes):
        put(x, i * gap, voice(hz(n), d, **kw), 1.0 if gains is None else gains[i])
    return x


def coin_cascade(count, base_note, span, d_each=.35, start_gap=.11, end_gap=.045, seed_notes=(0, 4, 7, 12)):
    """Coins pouring out: strikes that get quicker (accelerando) and climb through the chord, each a touch random."""
    gaps = np.linspace(start_gap, end_gap, count)
    times = np.concatenate([[0], np.cumsum(gaps[:-1])])
    x = np.zeros(int(SR * (times[-1] + d_each + .05)))
    for i, t in enumerate(times):
        n = base_note + seed_notes[i % len(seed_notes)] + 12 * (i // len(seed_notes)) % span
        put(x, t, bell(hz(n) * (1 + rng.uniform(-.01, .01)), d_each, decay=9, shimmer=1.2), .55 + .45 * i / max(1, count - 1))
    return x


def bass_hit(f, d=.6):
    """A soft, round bass: a sine with a quick downward pitch bend and a touch of second harmonic."""
    t = tt(d); fr = f * (1 + .6 * np.exp(-t * 30))
    ph = 2 * np.pi * np.cumsum(fr) / SR
    x = (np.sin(ph) + .25 * np.sin(2 * ph) * np.exp(-t * 10)) * adsr(len(t), .003, .12, .4, .35)
    return lowpass(x, 400)


def pad(notes, d, cutoff=1400):
    """A warm pad: detuned saw-ish partial stacks, slow attack, low-passed."""
    x = chord(notes, d, partials=((1, 1.0), (2, .5), (3, .33), (4, .25), (5, .2)), detune=.006, env=(.09, .2, .7, .45), bright=2.5)
    return lowpass(x, cutoff, 2)


def wood_tick(f=1900, d=.09, body=620):
    """A woody clock tick: a short band-limited click plus a damped wooden body resonance."""
    t = tt(d)
    click = highpass(lowpass(rng.normal(0, 1, len(t)), 5000), 1200) * np.exp(-t * 450)
    body_tone = np.sin(2 * np.pi * body * t) * np.exp(-t * 70) * .6 + np.sin(2 * np.pi * f * t) * np.exp(-t * 180) * .4
    return (click * .6 + body_tone) * np.minimum(1, t / .0008)


def drawer_thunk(d=.4):
    """The cash drawer: a low wooden thud with a short rattle of noise, then a faint slide."""
    t = tt(d)
    thud = np.sin(2 * np.pi * (85 + 60 * np.exp(-t * 40)) * t) * np.exp(-t * 18)
    rattle = lowpass(rng.normal(0, 1, len(t)), 2500) * np.exp(-t * 60) * .5
    slide = lowpass(rng.normal(0, 1, len(t)), 900) * np.exp(-np.maximum(0, t - .06) * 25) * (t > .06) * .18
    return (thud + rattle + slide) * np.minimum(1, t / .002)


# ---------- the set (key of A major; the C major cousins share the same notes) ----------
A4, Cs5, E5, A5, Cs6, E6 = 69, 73, 76, 81, 85, 88


def call_up():
    # a bright rising A major arpeggio (A5 C#6 E6), a coin-like bell over each note
    arp = arpeggio([A5, Cs6, E6], .09, .42, partials=((1, 1.0), (2, .3), (3, .12)), env=(.003, .08, .3, .25))
    coins = arpeggio([A5 + 12, Cs6 + 12, E6 + 12], .09, .32, voice=bell, decay=12, shimmer=.8)
    x = mix(.6, (0, arp, 1.0), (0, coins, .35))
    return finish(reverb(x, mix=.18, size=.8, decay=.7, tail=.0)[:int(SR * .6)], SOFT, lp=10000)


def call_down():
    # the same shape falling (E6 C#6 A5), an octave of the bells lower and a darker low-pass
    arp = arpeggio([E6, Cs6, A5], .09, .42, partials=((1, 1.0), (2, .3), (3, .12)), env=(.003, .08, .3, .25))
    coins = arpeggio([E6, Cs6, A5], .09, .32, voice=bell, decay=12, shimmer=.6)
    x = mix(.6, (0, arp, 1.0), (0, coins, .3))
    return finish(reverb(x, mix=.18, size=.9, decay=.7, tail=.0)[:int(SR * .6)], SOFT, lp=6500)


def filled():
    # ka-ching: a metallic ding (E6 bell with its fifth) and the cash drawer thunk under it, reverb tail
    x = mix(1.2, (0, bell(hz(E6), .9, decay=4.5, shimmer=1.3), 1.0), (0, bell(hz(E6 + 7), .7, decay=6), .5),
            (.07, drawer_thunk(.4), .9), (.055, bell(hz(A5 + 12), .5, decay=10), .3))
    return finish(reverb(x, mix=.28, size=1.1, decay=.8, tail=.0)[:int(SR * 1.2)], LOUD, lp=11000)


def win(big=False):
    # a slot-machine payout: ascending A major arpeggio (A C# E A), a shimmering coin cascade, a soft bass hit
    d = 3.0 if big else 2.0
    notes = [A4, Cs5, E5, A5, Cs6, E6, A5 + 12] if big else [A4, Cs5, E5, A5]
    arp = arpeggio(notes, .1, .9, partials=((1, 1.0), (2, .4), (3, .18), (4, .08)), env=(.003, .12, .4, .35))
    sustain = chord([A5, Cs6, E6], 1.1 if big else .8, partials=((1, 1.0), (2, .25)), env=(.02, .2, .5, .5))
    coins = coin_cascade(14 if big else 8, A5 + 12, 24, d_each=.4, start_gap=.11, end_gap=.04)
    bass = bass_hit(hz(A4 - 24), .9)
    parts = [(0, arp, .9), (.1 * (len(notes) - 1), sustain, .55), (.12 * len(notes) + .05, coins, .5), (0, bass, .7)]
    if big:
        parts += [(1.75, coin_cascade(10, E6, 24, d_each=.45, start_gap=.08, end_gap=.035), .4),
                  (1.5, chord([A4, Cs5, E5, A5], 1.3, partials=((1, 1.0), (2, .3), (3, .1)), env=(.02, .25, .55, .6)), .4),
                  (1.5, bass_hit(hz(A4 - 24), .9), .55)]
    x = mix(d, *parts)
    return finish(reverb(x, mix=.3, size=1.2, decay=.84, tail=.0)[:int(SR * d)], LOUD, lp=11000)


def loss():
    # warm and kind: two notes down (E5 -> C#5, a minor third) over a soft F#m pad, long reverb
    two = arpeggio([E5, Cs5], .32, .7, partials=((1, 1.0), (2, .3), (3, .1)), env=(.01, .15, .45, .4), gains=[1.0, .8])
    bed = pad([54, 57, 61, 64], 1.0, cutoff=1100)  # F#m (F#3 A3 C#4 E4), the relative minor of A
    x = mix(1.2, (0, two, 1.0), (0, bed, .5), (0, bass_hit(hz(54 - 12), .8), .25))
    return finish(reverb(x, mix=.35, size=1.3, decay=.86, tail=.0)[:int(SR * 1.2)], SOFT, lp=5500, drive=1.1, fade=.12)


def tick(): return finish(reverb(wood_tick(1900, .1, 620), mix=.1, size=.5, decay=.6, tail=.0)[:int(SR * .1)], SOFT, lp=8000)


def tick_final(): return finish(reverb(wood_tick(2500, .12, 820), mix=.12, size=.5, decay=.6, tail=.0)[:int(SR * .12)], SOFT + 2.5, lp=9000)


def close():
    # a short confirm: two-note blip (E5 -> A5), soft
    x = arpeggio([E5, A5], .09, .16, partials=((1, 1.0), (2, .3)), env=(.003, .05, .35, .08))
    return finish(mix(.25, (0, x, 1.0)), SOFT, lp=7000, fade=.04)


def ui_click():
    # subtle: a rounded tap (filtered noise plus a tiny body tone), no reverb
    t = tt(.05)
    x = (lowpass(rng.normal(0, 1, len(t)), 3200) * np.exp(-t * 400) * .6 + np.sin(2 * np.pi * 900 * t) * np.exp(-t * 150) * .4) * np.minimum(1, t / .0008)
    return finish(x, SOFT - 4, lp=6000, fade=.02)


SOUNDS = {
    'call-up': call_up, 'call-down': call_down, 'filled': filled, 'win': win, 'win-big': lambda: win(True), 'loss': loss,
    'tick': tick, 'tick-final': tick_final, 'close': close, 'ui-click': ui_click,
}

PEAK_TARGET = {'win': LOUD, 'win-big': LOUD, 'filled': LOUD}


# ---------- sanity ----------
def check(name, x):
    """Peak, true peak (4x), RMS, DC offset, end level (the fade) and the spectral centroid; returns the issues."""
    peak = 20 * np.log10(np.max(np.abs(x)))
    over = np.interp(np.arange(len(x) * 4) / 4, np.arange(len(x)), x)
    tp = 20 * np.log10(np.max(np.abs(over)))
    rms = 20 * np.log10(np.sqrt(np.mean(x ** 2)))
    dc = np.mean(x)
    end = np.max(np.abs(x[-int(SR * .003):]))
    spec = np.abs(np.fft.rfft(x)); freqs = np.fft.rfftfreq(len(x), 1 / SR)
    centroid = float(np.sum(freqs * spec) / (np.sum(spec) or 1))
    target = PEAK_TARGET.get(name, SOFT)
    issues = []
    if np.any(np.abs(x) >= 1.0): issues.append('clipping')
    if tp > -1.0: issues.append(f'true peak {tp:.1f} dBTP')
    if abs(dc) > 1e-3: issues.append(f'DC {dc:.4f}')
    if end > 1e-3: issues.append(f'abrupt end {end:.4f}')
    if abs(peak - target) > 3.5 and name not in ('tick-final', 'ui-click'): issues.append(f'peak {peak:.1f} vs {target}')
    return dict(peak=peak, tp=tp, rms=rms, dc=dc, end=end, centroid=centroid, issues=issues)


def write_wav(p, x):
    x = np.clip(x, -1, 1)
    with wave.open(str(p), 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((x * 32767).astype('<i2').tobytes())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--wav', action='store_true', help='write WAVs only (skip ffmpeg)')
    ap.add_argument('--check', action='store_true', help='render and report only, write nothing')
    args = ap.parse_args()
    ffmpeg = None if (args.wav or args.check) else shutil.which('ffmpeg')
    if not args.check: OUT.mkdir(parents=True, exist_ok=True)
    rows = []; bad = 0
    with tempfile.TemporaryDirectory() as tmp:
        for name, fn in SOUNDS.items():
            x = fn()
            rep = check(name, x); bad += bool(rep['issues'])
            outs = []
            if not args.check:
                wav = (OUT if not ffmpeg else Path(tmp)) / f'{name}.wav'
                write_wav(wav, x)
                outs = [wav]
                if ffmpeg:
                    outs = []
                    for ext, codec in (('ogg', ['-c:a', 'libvorbis', '-q:a', '4']), ('mp3', ['-c:a', 'libmp3lame', '-q:a', '4'])):
                        dst = OUT / f'{name}.{ext}'
                        subprocess.run([ffmpeg, '-y', '-loglevel', 'error', '-i', str(wav), *codec, str(dst)], check=True)
                        outs.append(dst)
            rows.append((name, len(x) / SR, rep, [(o.suffix[1:], o.stat().st_size) for o in outs]))
    for name, dur, rep, sizes in rows:
        print(f"{name:10s} {dur:5.2f}s peak {rep['peak']:6.1f} tp {rep['tp']:6.1f} rms {rep['rms']:6.1f} dBFS  dc {rep['dc']:+.5f} end {rep['end']:.5f} centroid {rep['centroid']:6.0f} Hz  "
              + '  '.join(f'{ext} {size / 1024:5.1f} KB' for ext, size in sizes) + ('  ISSUES: ' + ', '.join(rep['issues']) if rep['issues'] else '  ok'))
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
