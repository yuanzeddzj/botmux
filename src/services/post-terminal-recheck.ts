/** Recheck a verified terminal's input fence until it clears or its owner changes.
 * A timeout invalidates that attempt before retrying; its late continuation cannot write. */
export function createPostTerminalRecheck<Owner extends object>(options: {
  isCurrent: (owner: Owner) => boolean;
  probe: (owner: Owner, isCurrent: () => boolean) => Promise<void>;
  onError: (error: unknown) => void;
  onWait: (owner: Owner) => void;
  intervalMs?: number;
  probeTimeoutMs?: number;
  reportAfterMs?: number;
}) {
  const intervalMs = options.intervalMs ?? 3_500;
  const probeTimeoutMs = options.probeTimeoutMs ?? 2_000;
  const reportAfterMs = options.reportAfterMs ?? 60_000;
  let pending: { owner: Owner; timer?: ReturnType<typeof setTimeout>; lastReportAt: number; attempt: number } | undefined;

  function cancel(): void {
    if (pending?.timer) clearTimeout(pending.timer);
    pending = undefined;
  }

  function request(owner: Owner): void {
    if (pending?.owner === owner) return;
    cancel();
    const work = { owner, lastReportAt: Date.now(), attempt: 0 };
    pending = work;

    async function tick(): Promise<void> {
      if (pending !== work) return;
      if (!options.isCurrent(owner)) {
        cancel();
        return;
      }
      const attempt = ++work.attempt;
      const current = () => pending === work && work.attempt === attempt && options.isCurrent(owner);
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          options.probe(owner, current),
          new Promise<never>((_resolve, reject) => {
            deadline = setTimeout(() => {
              // Invalidate before rejecting, including already queued promise continuations.
              if (work.attempt === attempt) work.attempt++;
              reject(new Error('Post-terminal composer recheck timed out'));
            }, probeTimeoutMs);
            deadline.unref?.();
          }),
        ]);
      } catch (error) {
        if (pending === work) options.onError(error);
      } finally {
        if (deadline) clearTimeout(deadline);
      }
      if (pending !== work) return;
      // The attempt is over: even a timed-out underlying operation must stand down.
      if (work.attempt === attempt) work.attempt++;
      if (!options.isCurrent(owner)) {
        cancel();
        return;
      }
      if (Date.now() - work.lastReportAt >= reportAfterMs) {
        work.lastReportAt = Date.now();
        options.onWait(owner);
      }
      pending.timer = setTimeout(() => void tick(), intervalMs);
      pending.timer.unref?.();
    }
    void tick();
  }

  return { request, cancel };
}
