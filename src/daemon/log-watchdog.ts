import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { GatewayServiceRuntime } from "./service-runtime.js";
import { colorize, isRich, theme } from "../terminal/theme.js";
import {
  LOG_WATCHDOG_SCRIPT_NAME,
  LOG_WATCHDOG_STATS_FILE,
  resolveGatewayLaunchAgentLabel,
  resolveLogWatchdogLaunchAgentLabel,
} from "./constants.js";
import { buildLaunchAgentPlist as buildLaunchAgentPlistImpl } from "./launchd-plist.js";
import { resolveGatewayStateDir, resolveHomeDir } from "./paths.js";
import { parseKeyValueOutput } from "./runtime-parse.js";

const execFileAsync = promisify(execFile);
const toPosixPath = (value: string) => value.replace(/\\/g, "/");

const formatLine = (label: string, value: string) => {
  const rich = isRich();
  return `${colorize(rich, theme.muted, `${label}:`)} ${colorize(rich, theme.command, value)}`;
};

async function execLaunchctl(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("launchctl", args, {
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    return {
      stdout: String(stdout ?? ""),
      stderr: String(stderr ?? ""),
      code: 0,
    };
  } catch (error) {
    const e = error as {
      stdout?: unknown;
      stderr?: unknown;
      code?: unknown;
      message?: unknown;
    };
    return {
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr:
        typeof e.stderr === "string" ? e.stderr : typeof e.message === "string" ? e.message : "",
      code: typeof e.code === "number" ? e.code : 1,
    };
  }
}

function resolveGuiDomain(): string {
  if (typeof process.getuid !== "function") {
    return "gui/501";
  }
  return `gui/${process.getuid()}`;
}

export type LogWatchdogPaths = {
  scriptPath: string;
  plistPath: string;
  statsPath: string;
  logPath: string;
  gatewayLogPath: string;
};

export function resolveLogWatchdogPaths(env: Record<string, string | undefined>): LogWatchdogPaths {
  const home = toPosixPath(resolveHomeDir(env));
  const stateDir = resolveGatewayStateDir(env);
  const label = resolveLogWatchdogLaunchAgentLabel(env.OPENCLAW_PROFILE);
  const logPrefix = env.OPENCLAW_LOG_PREFIX?.trim() || "gateway";

  return {
    scriptPath: path.join(stateDir, "bin", LOG_WATCHDOG_SCRIPT_NAME),
    plistPath: path.posix.join(home, "Library", "LaunchAgents", `${label}.plist`),
    statsPath: path.join(stateDir, LOG_WATCHDOG_STATS_FILE),
    logPath: path.join(stateDir, "logs", "log-watchdog.log"),
    gatewayLogPath: path.join(stateDir, "logs", `${logPrefix}.log`),
  };
}

export function buildLogWatchdogScript(params: {
  gatewayLogPath: string;
  gatewayLabel: string;
  statsPath: string;
}): string {
  const { gatewayLogPath, gatewayLabel, statsPath } = params;
  // Shell script that monitors gateway log for EBADF and sends SIGUSR1 to restart
  return `#!/bin/bash
# OpenClaw Log Watchdog
# Monitors gateway.log for EBADF errors and triggers a graceful restart via SIGUSR1.

LOG_FILE="${gatewayLogPath}"
GATEWAY_LABEL="${gatewayLabel}"
STATS_FILE="${statsPath}"
EBADF_THRESHOLD=\${WATCHDOG_THRESHOLD:-3}
COOLDOWN=\${WATCHDOG_COOLDOWN:-120}

LAST_RESTART=0
TOTAL_RESTARTS=0
EBADF_COUNT=0

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

get_gateway_pid() {
  launchctl print "gui/$UID/$GATEWAY_LABEL" 2>/dev/null |
    grep -oE 'pid = [0-9]+' | grep -oE '[0-9]+' || echo ""
}

write_stats() {
  cat > "$STATS_FILE" <<EOF
{"lastRestart":$LAST_RESTART,"totalRestarts":$TOTAL_RESTARTS,"lastCheck":$(date +%s)}
EOF
}

restart_gateway() {
  local now=$(date +%s)
  if (( now - LAST_RESTART < COOLDOWN )); then
    log "Cooldown active, skipping restart (last restart $(( now - LAST_RESTART ))s ago)"
    return 1
  fi

  local pid=$(get_gateway_pid)
  if [[ -n "$pid" ]]; then
    log "Sending SIGUSR1 to gateway (pid=$pid)"
    kill -USR1 "$pid" 2>/dev/null
    LAST_RESTART=$now
    ((TOTAL_RESTARTS++))
    EBADF_COUNT=0
    write_stats
    return 0
  else
    log "Gateway not running, cannot send signal"
    return 1
  fi
}

# Load existing stats if available
if [[ -f "$STATS_FILE" ]]; then
  TOTAL_RESTARTS=$(grep -oE '"totalRestarts":[0-9]+' "$STATS_FILE" 2>/dev/null | grep -oE '[0-9]+' || echo "0")
fi

log "Watchdog started (log=$LOG_FILE, label=$GATEWAY_LABEL, threshold=$EBADF_THRESHOLD, cooldown=\${COOLDOWN}s)"
write_stats

# Monitor log file for EBADF errors
tail -F "$LOG_FILE" 2>/dev/null | while read -r line; do
  if echo "$line" | grep -qiE "EBADF|spawn.*EBADF|bad file descriptor"; then
    ((EBADF_COUNT++))
    log "EBADF detected (count=$EBADF_COUNT/$EBADF_THRESHOLD)"
    if (( EBADF_COUNT >= EBADF_THRESHOLD )); then
      restart_gateway
    fi
  fi
done
`;
}

function buildLogWatchdogPlist(params: {
  label: string;
  scriptPath: string;
  logPath: string;
  gatewayLogPath: string;
  gatewayLabel: string;
  statsPath: string;
}): string {
  const { label, scriptPath, logPath, gatewayLogPath, gatewayLabel, statsPath } = params;
  return buildLaunchAgentPlistImpl({
    label,
    comment: "OpenClaw Log Watchdog",
    programArguments: ["/bin/bash", scriptPath],
    stdoutPath: logPath,
    stderrPath: logPath,
    environment: {
      OPENCLAW_LOG_FILE: gatewayLogPath,
      OPENCLAW_GATEWAY_LABEL: gatewayLabel,
      OPENCLAW_STATS_FILE: statsPath,
    },
  });
}

export async function installLogWatchdog(args: {
  env: Record<string, string | undefined>;
  stdout: NodeJS.WritableStream;
}): Promise<{ scriptPath: string; plistPath: string }> {
  const { env, stdout } = args;
  const paths = resolveLogWatchdogPaths(env);
  const gatewayLabel = resolveGatewayLaunchAgentLabel(env.OPENCLAW_PROFILE);
  const watchdogLabel = resolveLogWatchdogLaunchAgentLabel(env.OPENCLAW_PROFILE);
  const domain = resolveGuiDomain();

  // Create directories
  await fs.mkdir(path.dirname(paths.scriptPath), { recursive: true });
  await fs.mkdir(path.dirname(paths.logPath), { recursive: true });
  await fs.mkdir(path.dirname(paths.plistPath), { recursive: true });

  // Write shell script
  const script = buildLogWatchdogScript({
    gatewayLogPath: paths.gatewayLogPath,
    gatewayLabel,
    statsPath: paths.statsPath,
  });
  await fs.writeFile(paths.scriptPath, script, { mode: 0o755 });

  // Write plist
  const plist = buildLogWatchdogPlist({
    label: watchdogLabel,
    scriptPath: paths.scriptPath,
    logPath: paths.logPath,
    gatewayLogPath: paths.gatewayLogPath,
    gatewayLabel,
    statsPath: paths.statsPath,
  });
  await fs.writeFile(paths.plistPath, plist, "utf8");

  // Unload any existing agent and bootstrap the new one
  await execLaunchctl(["bootout", domain, paths.plistPath]);
  await execLaunchctl(["unload", paths.plistPath]);
  await execLaunchctl(["enable", `${domain}/${watchdogLabel}`]);
  const boot = await execLaunchctl(["bootstrap", domain, paths.plistPath]);
  if (boot.code !== 0) {
    throw new Error(`Log watchdog bootstrap failed: ${boot.stderr || boot.stdout}`.trim());
  }
  await execLaunchctl(["kickstart", "-k", `${domain}/${watchdogLabel}`]);

  stdout.write(`${formatLine("Installed log watchdog", paths.plistPath)}\n`);
  return { scriptPath: paths.scriptPath, plistPath: paths.plistPath };
}

export async function uninstallLogWatchdog(args: {
  env: Record<string, string | undefined>;
  stdout: NodeJS.WritableStream;
}): Promise<void> {
  const { env, stdout } = args;
  const paths = resolveLogWatchdogPaths(env);
  const watchdogLabel = resolveLogWatchdogLaunchAgentLabel(env.OPENCLAW_PROFILE);
  const domain = resolveGuiDomain();

  // Bootout and unload
  await execLaunchctl(["bootout", domain, paths.plistPath]);
  await execLaunchctl(["unload", paths.plistPath]);

  // Remove plist
  try {
    await fs.unlink(paths.plistPath);
    stdout.write(`${formatLine("Removed log watchdog plist", paths.plistPath)}\n`);
  } catch {
    // File may not exist
  }

  // Remove script
  try {
    await fs.unlink(paths.scriptPath);
  } catch {
    // File may not exist
  }

  // Remove stats file
  try {
    await fs.unlink(paths.statsPath);
  } catch {
    // File may not exist
  }

  stdout.write(`${formatLine("Uninstalled log watchdog", watchdogLabel)}\n`);
}

export async function isLogWatchdogLoaded(
  env: Record<string, string | undefined>,
): Promise<boolean> {
  const domain = resolveGuiDomain();
  const label = resolveLogWatchdogLaunchAgentLabel(env.OPENCLAW_PROFILE);
  const res = await execLaunchctl(["print", `${domain}/${label}`]);
  return res.code === 0;
}

export async function readLogWatchdogRuntime(
  env: Record<string, string | undefined>,
): Promise<GatewayServiceRuntime> {
  const domain = resolveGuiDomain();
  const label = resolveLogWatchdogLaunchAgentLabel(env.OPENCLAW_PROFILE);
  const res = await execLaunchctl(["print", `${domain}/${label}`]);
  if (res.code !== 0) {
    return {
      status: "unknown",
      detail: (res.stderr || res.stdout).trim() || undefined,
      missingUnit: true,
    };
  }
  const output = res.stdout || res.stderr || "";
  const entries = parseKeyValueOutput(output, "=");

  const state = entries.state?.toLowerCase();
  const pidStr = entries.pid;
  const pid = pidStr ? Number.parseInt(pidStr, 10) : undefined;
  const status = state === "running" || pid ? "running" : state ? "stopped" : "unknown";

  return {
    status,
    state: entries.state,
    pid: Number.isFinite(pid) ? pid : undefined,
  };
}

export type LogWatchdogStats = {
  lastRestart?: number;
  totalRestarts?: number;
  lastCheck?: number;
};

export async function readLogWatchdogStats(
  env: Record<string, string | undefined>,
): Promise<LogWatchdogStats | null> {
  const paths = resolveLogWatchdogPaths(env);
  try {
    const content = await fs.readFile(paths.statsPath, "utf8");
    const parsed = JSON.parse(content);
    return {
      lastRestart: typeof parsed.lastRestart === "number" ? parsed.lastRestart : undefined,
      totalRestarts: typeof parsed.totalRestarts === "number" ? parsed.totalRestarts : undefined,
      lastCheck: typeof parsed.lastCheck === "number" ? parsed.lastCheck : undefined,
    };
  } catch {
    return null;
  }
}
