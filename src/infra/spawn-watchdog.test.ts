import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock scheduleGatewaySigusr1Restart before importing spawn-watchdog
vi.mock("./restart.js", () => ({
  scheduleGatewaySigusr1Restart: vi.fn(),
}));

// Mock spawn-utils setSpawnWatchdogCallbacks
vi.mock("../process/spawn-utils.js", () => ({
  setSpawnWatchdogCallbacks: vi.fn(),
}));

import { scheduleGatewaySigusr1Restart } from "./restart.js";
import {
  __testing,
  getSpawnWatchdogStats,
  recordSpawnFailure,
  startSpawnWatchdog,
  stopSpawnWatchdog,
} from "./spawn-watchdog.js";

describe("spawn-watchdog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __testing.reset();
  });

  afterEach(() => {
    __testing.reset();
  });

  it("starts and stops without error", () => {
    startSpawnWatchdog();
    expect(__testing.getState().isEnabled).toBe(true);

    stopSpawnWatchdog();
    expect(__testing.getState().isEnabled).toBe(false);
  });

  it("tracks spawn failures", () => {
    startSpawnWatchdog();

    recordSpawnFailure();
    recordSpawnFailure();

    const stats = getSpawnWatchdogStats();
    expect(stats.recentFailures).toBe(2);
    expect(stats.enabled).toBe(true);
  });

  it("does not trigger restart below threshold", () => {
    startSpawnWatchdog();

    // Record failures below threshold (5)
    for (let i = 0; i < 4; i++) {
      recordSpawnFailure();
    }

    expect(scheduleGatewaySigusr1Restart).not.toHaveBeenCalled();
  });

  it("does not record failures when disabled", () => {
    // Don't start watchdog
    recordSpawnFailure();
    recordSpawnFailure();

    const stats = getSpawnWatchdogStats();
    expect(stats.recentFailures).toBe(0);
    expect(stats.enabled).toBe(false);
  });

  it("returns correct stats", () => {
    const stats = getSpawnWatchdogStats();

    expect(stats).toHaveProperty("enabled");
    expect(stats).toHaveProperty("recentFailures");
    expect(stats).toHaveProperty("lastRestartAt");
    expect(stats).toHaveProperty("timeSinceLastRestart");
  });

  it("can be reset via __testing.reset()", () => {
    startSpawnWatchdog();
    recordSpawnFailure();
    recordSpawnFailure();

    __testing.reset();

    const state = __testing.getState();
    expect(state.isEnabled).toBe(false);
    expect(state.spawnFailures).toHaveLength(0);
    expect(state.lastRestartAt).toBe(0);
  });
});
