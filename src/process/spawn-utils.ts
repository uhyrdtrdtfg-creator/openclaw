import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawn } from "node:child_process";

// Optional watchdog integration - lazy imported to avoid circular deps
let recordSpawnFailureFn: (() => void) | null = null;
let recordSpawnSuccessFn: (() => void) | null = null;

/**
 * Register watchdog callbacks for spawn monitoring.
 * This is called by the spawn-watchdog module during initialization.
 */
export function setSpawnWatchdogCallbacks(
  callbacks: {
    recordFailure: () => void;
    recordSuccess: () => void;
  } | null,
): void {
  if (callbacks) {
    recordSpawnFailureFn = callbacks.recordFailure;
    recordSpawnSuccessFn = callbacks.recordSuccess;
  } else {
    recordSpawnFailureFn = null;
    recordSpawnSuccessFn = null;
  }
}

export type SpawnFallback = {
  label: string;
  options: SpawnOptions;
};

export type SpawnWithFallbackResult = {
  child: ChildProcess;
  usedFallback: boolean;
  fallbackLabel?: string;
};

type SpawnWithFallbackParams = {
  argv: string[];
  options: SpawnOptions;
  fallbacks?: SpawnFallback[];
  spawnImpl?: typeof spawn;
  retryCodes?: string[];
  onFallback?: (err: unknown, fallback: SpawnFallback) => void;
};

const DEFAULT_RETRY_CODES = ["EBADF"];

// EBADF auto-recovery: track consecutive EBADF errors
const EBADF_RECOVERY_THRESHOLD = 3; // Trigger restart after 3 consecutive EBADF errors
const EBADF_RECOVERY_WINDOW_MS = 60_000; // Reset counter if no EBADF for 1 minute
const EBADF_RECOVERY_COOLDOWN_MS = 120_000; // Don't trigger restart more than once per 2 minutes

let ebadfErrorCount = 0;
let ebadfLastErrorAt = 0;
let ebadfLastRecoveryAt = 0;
let ebadfRecoveryCallback: (() => void) | null = null;

/**
 * Register a callback to be invoked when EBADF errors exceed threshold.
 * Typically used to trigger a Gateway SIGUSR1 restart.
 */
export function setEbadfRecoveryCallback(callback: (() => void) | null): void {
  ebadfRecoveryCallback = callback;
}

/**
 * Record an EBADF error occurrence and trigger recovery if threshold is exceeded.
 */
function recordEbadfError(): void {
  const now = Date.now();

  // Reset counter if outside the recovery window
  if (now - ebadfLastErrorAt > EBADF_RECOVERY_WINDOW_MS) {
    ebadfErrorCount = 0;
  }

  ebadfErrorCount += 1;
  ebadfLastErrorAt = now;

  // Check if we should trigger recovery
  if (
    ebadfErrorCount >= EBADF_RECOVERY_THRESHOLD &&
    now - ebadfLastRecoveryAt > EBADF_RECOVERY_COOLDOWN_MS &&
    ebadfRecoveryCallback
  ) {
    ebadfLastRecoveryAt = now;
    ebadfErrorCount = 0; // Reset counter after triggering
    try {
      ebadfRecoveryCallback();
    } catch {
      // Ignore callback errors
    }
  }
}

/**
 * Reset EBADF error counter (e.g., after successful spawn).
 */
function resetEbadfCounter(): void {
  ebadfErrorCount = 0;
}

export const __ebadfTesting = {
  getState: () => ({
    errorCount: ebadfErrorCount,
    lastErrorAt: ebadfLastErrorAt,
    lastRecoveryAt: ebadfLastRecoveryAt,
  }),
  reset: () => {
    ebadfErrorCount = 0;
    ebadfLastErrorAt = 0;
    ebadfLastRecoveryAt = 0;
    ebadfRecoveryCallback = null;
  },
};

export function resolveCommandStdio(params: {
  hasInput: boolean;
  preferInherit: boolean;
}): ["pipe" | "inherit" | "ignore", "pipe", "pipe"] {
  const stdin = params.hasInput ? "pipe" : params.preferInherit ? "inherit" : "pipe";
  return [stdin, "pipe", "pipe"];
}

export function formatSpawnError(err: unknown): string {
  if (!(err instanceof Error)) {
    return String(err);
  }
  const details = err as NodeJS.ErrnoException;
  const parts: string[] = [];
  const message = err.message?.trim();
  if (message) {
    parts.push(message);
  }
  if (details.code && !message?.includes(details.code)) {
    parts.push(details.code);
  }
  if (details.syscall) {
    parts.push(`syscall=${details.syscall}`);
  }
  if (typeof details.errno === "number") {
    parts.push(`errno=${details.errno}`);
  }
  return parts.join(" ");
}

function shouldRetry(err: unknown, codes: string[]): boolean {
  const code =
    err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code) : "";
  return code.length > 0 && codes.includes(code);
}

async function spawnAndWaitForSpawn(
  spawnImpl: typeof spawn,
  argv: string[],
  options: SpawnOptions,
): Promise<ChildProcess> {
  const child = spawnImpl(argv[0], argv.slice(1), options);

  return await new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      child.removeListener("error", onError);
      child.removeListener("spawn", onSpawn);
    };
    const finishResolve = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(child);
    };
    const onError = (err: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(err);
    };
    const onSpawn = () => {
      finishResolve();
    };
    child.once("error", onError);
    child.once("spawn", onSpawn);
    // Ensure mocked spawns that never emit "spawn" don't stall.
    process.nextTick(() => {
      if (typeof child.pid === "number") {
        finishResolve();
      }
    });
  });
}

export async function spawnWithFallback(
  params: SpawnWithFallbackParams,
): Promise<SpawnWithFallbackResult> {
  const spawnImpl = params.spawnImpl ?? spawn;
  const retryCodes = params.retryCodes ?? DEFAULT_RETRY_CODES;
  const baseOptions = { ...params.options };
  const fallbacks = params.fallbacks ?? [];
  const attempts: Array<{ label?: string; options: SpawnOptions }> = [
    { options: baseOptions },
    ...fallbacks.map((fallback) => ({
      label: fallback.label,
      options: { ...baseOptions, ...fallback.options },
    })),
  ];

  let lastError: unknown;
  let hadEbadfError = false;
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    try {
      const child = await spawnAndWaitForSpawn(spawnImpl, params.argv, attempt.options);
      // Successful spawn - reset EBADF counter only if we didn't have EBADF in this call
      if (!hadEbadfError) {
        resetEbadfCounter();
      }
      // Notify watchdog of success
      recordSpawnSuccessFn?.();
      return {
        child,
        usedFallback: index > 0,
        fallbackLabel: attempt.label,
      };
    } catch (err) {
      lastError = err;
      const isEbadf = shouldRetry(err, ["EBADF"]);
      if (isEbadf) {
        hadEbadfError = true;
        recordEbadfError();
      }
      // Notify watchdog of failure
      recordSpawnFailureFn?.();
      const nextFallback = fallbacks[index];
      if (!nextFallback || !shouldRetry(err, retryCodes)) {
        throw err;
      }
      params.onFallback?.(err, nextFallback);
    }
  }

  throw lastError;
}
