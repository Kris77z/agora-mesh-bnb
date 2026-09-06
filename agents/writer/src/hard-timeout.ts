export async function withHardTimeout<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
  label: string
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Hard timeout must be a positive integer");
  }
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error(`${label} timed out after ${timeoutMs} ms`));
      reject(new Error(`${label} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    if (!controller.signal.aborted) controller.abort();
  }
}
