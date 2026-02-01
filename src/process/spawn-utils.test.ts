import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __ebadfTesting, setEbadfRecoveryCallback, spawnWithFallback } from "./spawn-utils.js";

function createStubChild() {
  const child = new EventEmitter() as ChildProcess;
  child.stdin = new PassThrough() as ChildProcess["stdin"];
  child.stdout = new PassThrough() as ChildProcess["stdout"];
  child.stderr = new PassThrough() as ChildProcess["stderr"];
  child.pid = 1234;
  child.killed = false;
  child.kill = vi.fn(() => true) as ChildProcess["kill"];
  queueMicrotask(() => {
    child.emit("spawn");
  });
  return child;
}

describe("spawnWithFallback", () => {
  it("retries on EBADF using fallback options", async () => {
    const spawnMock = vi
      .fn()
      .mockImplementationOnce(() => {
        const err = new Error("spawn EBADF");
        (err as NodeJS.ErrnoException).code = "EBADF";
        throw err;
      })
      .mockImplementationOnce(() => createStubChild());

    const result = await spawnWithFallback({
      argv: ["echo", "ok"],
      options: { stdio: ["pipe", "pipe", "pipe"] },
      fallbacks: [{ label: "safe-stdin", options: { stdio: ["ignore", "pipe", "pipe"] } }],
      spawnImpl: spawnMock,
    });

    expect(result.usedFallback).toBe(true);
    expect(result.fallbackLabel).toBe("safe-stdin");
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[0]?.[2]?.stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(spawnMock.mock.calls[1]?.[2]?.stdio).toEqual(["ignore", "pipe", "pipe"]);
  });

  it("does not retry on non-EBADF errors", async () => {
    const spawnMock = vi.fn().mockImplementationOnce(() => {
      const err = new Error("spawn ENOENT");
      (err as NodeJS.ErrnoException).code = "ENOENT";
      throw err;
    });

    await expect(
      spawnWithFallback({
        argv: ["missing"],
        options: { stdio: ["pipe", "pipe", "pipe"] },
        fallbacks: [{ label: "safe-stdin", options: { stdio: ["ignore", "pipe", "pipe"] } }],
        spawnImpl: spawnMock,
      }),
    ).rejects.toThrow(/ENOENT/);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});

describe("EBADF auto-recovery", () => {
  beforeEach(() => {
    __ebadfTesting.reset();
  });

  afterEach(() => {
    __ebadfTesting.reset();
  });

  it("triggers recovery callback after consecutive EBADF errors", async () => {
    const recoveryCallback = vi.fn();
    setEbadfRecoveryCallback(recoveryCallback);

    // Create mock that always fails with EBADF (no fallback)
    const spawnMock = vi.fn().mockImplementation(() => {
      const err = new Error("spawn EBADF");
      (err as NodeJS.ErrnoException).code = "EBADF";
      throw err;
    });

    // Trigger 3 EBADF errors (threshold)
    for (let i = 0; i < 3; i++) {
      try {
        await spawnWithFallback({
          argv: ["test"],
          options: { stdio: ["pipe", "pipe", "pipe"] },
          fallbacks: [], // No fallbacks, will throw on first EBADF
          spawnImpl: spawnMock,
        });
      } catch {
        // Expected to fail
      }
    }

    expect(recoveryCallback).toHaveBeenCalledTimes(1);
  });

  it("does not trigger recovery before threshold is reached", async () => {
    const recoveryCallback = vi.fn();
    setEbadfRecoveryCallback(recoveryCallback);

    const spawnMock = vi.fn().mockImplementation(() => {
      const err = new Error("spawn EBADF");
      (err as NodeJS.ErrnoException).code = "EBADF";
      throw err;
    });

    // Only 2 EBADF errors (below threshold of 3)
    for (let i = 0; i < 2; i++) {
      try {
        await spawnWithFallback({
          argv: ["test"],
          options: { stdio: ["pipe", "pipe", "pipe"] },
          fallbacks: [],
          spawnImpl: spawnMock,
        });
      } catch {
        // Expected to fail
      }
    }

    expect(recoveryCallback).not.toHaveBeenCalled();
  });

  it("resets counter on successful spawn", async () => {
    const recoveryCallback = vi.fn();
    setEbadfRecoveryCallback(recoveryCallback);

    const failingMock = vi.fn().mockImplementation(() => {
      const err = new Error("spawn EBADF");
      (err as NodeJS.ErrnoException).code = "EBADF";
      throw err;
    });

    const succeedingMock = vi.fn().mockImplementation(() => createStubChild());

    // 2 EBADF errors
    for (let i = 0; i < 2; i++) {
      try {
        await spawnWithFallback({
          argv: ["test"],
          options: { stdio: ["pipe", "pipe", "pipe"] },
          fallbacks: [],
          spawnImpl: failingMock,
        });
      } catch {
        // Expected
      }
    }

    // Successful spawn resets counter
    await spawnWithFallback({
      argv: ["test"],
      options: { stdio: ["pipe", "pipe", "pipe"] },
      fallbacks: [],
      spawnImpl: succeedingMock,
    });

    // 2 more EBADF errors (total should be 2, not 4)
    for (let i = 0; i < 2; i++) {
      try {
        await spawnWithFallback({
          argv: ["test"],
          options: { stdio: ["pipe", "pipe", "pipe"] },
          fallbacks: [],
          spawnImpl: failingMock,
        });
      } catch {
        // Expected
      }
    }

    // Should not have triggered (only 2 consecutive, not 3)
    expect(recoveryCallback).not.toHaveBeenCalled();
  });
});
