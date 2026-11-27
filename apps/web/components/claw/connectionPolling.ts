/** Leave a full retry interval after a completed check, including failed checks. */
export function pollConnection(check: () => Promise<void>, allowed: () => boolean,
  clock = { later: (callback: () => void, ms: number) => setTimeout(callback, ms), cancel: (id: ReturnType<typeof setTimeout>) => clearTimeout(id) }) {
  let stopped = false, timer: ReturnType<typeof setTimeout>;
  const tick = async () => {
    try { if (allowed()) await check(); }
    finally { if (!stopped) timer = clock.later(() => void tick(), 15000); }
  };
  timer = clock.later(() => void tick(), 0);
  return () => { stopped = true; clock.cancel(timer); };
}
