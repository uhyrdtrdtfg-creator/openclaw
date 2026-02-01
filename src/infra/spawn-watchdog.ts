/**
 * Spawn Watchdog - monitors spawn health and triggers recovery when needed.
 *
 * This watchdog monitors the spawn subsystem for persistent failures
 * (like EBADF errors) and can trigger gateway restart when the spawn
 * subsystem becomes unhealthy.
 *
 * The watchdog provides:
 * - Periodic health checks of spawn operations
 * - Tracking of consecutive spawn failures
 * - Automatic restart triggering via SIGUSR1
 * - Cooldown periods to prevent restart storms
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import { setSpawnWatchdogCallbacks } from "../process/spawn-utils.js";
import { scheduleGatewaySigusr1Restart } from "./restart.js";

const log = createSubsystemLogger("spawn-watchdog");

// Watchdog configuration
const WATCHDOG_CHECK_INTERVAL_MS = 30_000; // Check every 30 seconds
const HEALTH_THRESHOLD_FAILURES = 5; // Trigger restart after 5 failures in window
const HEALTH_WINDOW_MS = 120_000; // 2-minute sliding window for failure tracking
const RESTART_COOLDOWN_MS = 300_000; // 5 minutes between restarts

// State tracking
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let spawnFailures: number[] = []; // Timestamps of recent spawn failures
let lastRestartAt = 0;
let isEnabled = false;

export type SpawnWatchdogStats = {
  enabled: boolean;
  recentFailures: number;
  lastRestartAt: number;
  timeSinceLastRestart: number;
};

/**
 * Record a spawn failure for watchdog tracking.
 * This should be called whenever a spawn operation fails.
 */
export function recordSpawnFailure(): void {
  if (!isEnabled) return;

  const now = Date.now();
  spawnFailures.push(now);

  // Clean up old failures outside the window
  const cutoff = now - HEALTH_WINDOW_MS;
  spawnFailures = spawnFailures.filter((ts) => ts > cutoff);

  log.debug(`spawn failure recorded; ${spawnFailures.length} failures in window`);
}

/**
 * Record a successful spawn for watchdog tracking.
 * This can be used to reset failure counters on recovery.
 */
export function recordSpawnSuccess(): void {
  if (!isEnabled) return;

  // A successful spawn is a good sign; we could optionally clear some failures
  // For now, we just let the window naturally expire old failures
}

/**
 * Check if the spawn subsystem is healthy.
 */
function checkSpawnHealth(): void {
  const now = Date.now();

  // Clean up old failures outside the window
  const cutoff = now - HEALTH_WINDOW_MS;
  spawnFailures = spawnFailures.filter((ts) => ts > cutoff);

  const failureCount = spawnFailures.length;

  if (failureCount < HEALTH_THRESHOLD_FAILURES) {
    return; // Healthy
  }

  // Check cooldown
  if (now - lastRestartAt < RESTART_COOLDOWN_MS) {
    log.warn(
      `spawn unhealthy (${failureCount} failures) but in cooldown; ` +
        `${Math.round((RESTART_COOLDOWN_MS - (now - lastRestartAt)) / 1000)}s until next restart allowed`,
    );
    return;
  }

  // Trigger restart
  log.warn(
    `spawn subsystem unhealthy: ${failureCount} failures in ${HEALTH_WINDOW_MS / 1000}s; triggering restart`,
  );
  lastRestartAt = now;
  spawnFailures = []; // Reset after triggering

  scheduleGatewaySigusr1Restart({
    reason: "spawn-watchdog-health-check",
    delayMs: 1000,
  });
}

/**
 * Get current watchdog statistics.
 */
export function getSpawnWatchdogStats(): SpawnWatchdogStats {
  const now = Date.now();
  const cutoff = now - HEALTH_WINDOW_MS;
  const recentFailures = spawnFailures.filter((ts) => ts > cutoff).length;

  return {
    enabled: isEnabled,
    recentFailures,
    lastRestartAt,
    timeSinceLastRestart: lastRestartAt > 0 ? now - lastRestartAt : -1,
  };
}

/**
 * Start the spawn watchdog.
 * This should be called when the gateway starts.
 */
export function startSpawnWatchdog(): void {
  if (watchdogTimer) {
    return; // Already running
  }

  isEnabled = true;
  spawnFailures = [];
  log.info("spawn watchdog started");

  // Register callbacks with spawn-utils
  setSpawnWatchdogCallbacks({
    recordFailure: recordSpawnFailure,
    recordSuccess: recordSpawnSuccess,
  });

  watchdogTimer = setInterval(() => {
    checkSpawnHealth();
  }, WATCHDOG_CHECK_INTERVAL_MS);

  // Don't block process shutdown
  watchdogTimer.unref?.();
}

/**
 * Stop the spawn watchdog.
 * This should be called when the gateway stops.
 */
export function stopSpawnWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }

  // Unregister callbacks
  setSpawnWatchdogCallbacks(null);

  isEnabled = false;
  log.info("spawn watchdog stopped");
}

/**
 * Reset watchdog state (primarily for testing).
 */
export const __testing = {
  reset: () => {
    stopSpawnWatchdog();
    spawnFailures = [];
    lastRestartAt = 0;
  },
  getState: () => ({
    isEnabled,
    spawnFailures: [...spawnFailures],
    lastRestartAt,
  }),
  // Expose constants for testing
  HEALTH_THRESHOLD_FAILURES,
  HEALTH_WINDOW_MS,
  RESTART_COOLDOWN_MS,
};
