/** Six separate songs, each about 1.3 MB, so a visit only streams what it plays. */
export const BACKGROUND_TRACKS = Object.freeze([1, 2, 3, 4, 5, 6].map(n => `/claw/music/city-pop-${n}.m4a`));
export const BACKGROUND_VOLUME = .055;
export const MUSIC_STORAGE_KEY = "cato-claw-music-muted-v1";

/** Shuffle-bag order: every song plays once per round, and a round never opens with the song that just ended. */
export function createTrackQueue(tracks: readonly string[] = BACKGROUND_TRACKS, random: () => number = Math.random) {
  let queue: string[] = [], last: string | null = null;
  return function next() {
    if (!queue.length) {
      queue = [...tracks];
      for (let i = queue.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [queue[i], queue[j]] = [queue[j], queue[i]]; }
      if (queue.length > 1 && queue[0] === last) [queue[0], queue[1]] = [queue[1], queue[0]];
    }
    last = queue.shift()!;
    return last;
  };
}

/** Stream one song at a time on interaction; never preload during startup. */
export function createBackgroundMusic(createAudio: () => HTMLAudioElement, onError: (failed: boolean) => void = () => {}, random: () => number = Math.random) {
  let audio: HTMLAudioElement | null = null, muted = false, hidden = false, activated = false, disposed = false;
  let generation = 0, pending: Promise<void> | null = null;
  const nextTrack = createTrackQueue(BACKGROUND_TRACKS, random);
  function pause() { generation++; pending = null; audio?.pause(); }
  function start() {
    if (disposed || muted || hidden || !activated) return;
    if (!audio) {
      const element = createAudio(); audio = element;
      element.preload = "none"; element.loop = false; element.volume = BACKGROUND_VOLUME; element.src = nextTrack();
      // When a song finishes, move to the next one in the shuffled order.
      element.onended = () => { if (disposed || audio !== element) return; generation++; pending = null; element.src = nextTrack(); start(); };
    }
    if (!audio.paused || pending) return;
    const epoch = generation;
    pending = audio.play().then(() => { if (epoch === generation && !disposed) onError(false); }).catch(error => {
      if (epoch !== generation || disposed) return;
      if (error?.name !== "NotAllowedError" && error?.name !== "AbortError") onError(true);
    }).finally(() => { if (epoch === generation) pending = null; });
  }
  return {
    activate() { activated = true; start(); },
    setMuted(value: boolean) { muted = value; if (value) pause(); else start(); },
    setHidden(value: boolean) { hidden = value; if (value) pause(); else start(); },
    dispose() { if (disposed) return; pause(); disposed = true; if (audio) { audio.onended = null; audio.removeAttribute("src"); audio.load(); audio = null; } },
  };
}
