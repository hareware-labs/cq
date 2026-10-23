import { writeFileSync, existsSync, unlinkSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve, basename } from 'node:path';

/**
 * launchd integration.
 *
 * This is the only platform-specific module besides `notify`. Everything the scheduler
 * does works identically without it; the daemon just keeps `cq run` alive across
 * logouts and reboots so a multi-day seven-day park survives.
 */

export const LAUNCH_AGENTS = join(homedir(), 'Library', 'LaunchAgents');
export const LOG_DIR = join(homedir(), 'Library', 'Logs', 'cq');

/** One agent per target repo, so several queues can run side by side. */
export function labelFor(root) {
  const slug = resolve(root).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
  return `com.cq.queue.${slug}`;
}

export function plistPath(root) { return join(LAUNCH_AGENTS, `${labelFor(root)}.plist`); }

const xml = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

export function buildPlist(root, { nodeBin = process.execPath, cliPath, extraArgs = [], env = {} } = {}) {
  const label = labelFor(root);
  const args = [nodeBin, cliPath, 'run', ...extraArgs];
  const envEntries = Object.entries({
    // launchd starts with a minimal PATH, so `claude` must be findable explicitly.
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: homedir(),
    ...env,
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${xml(resolve(root))}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries.map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`).join('\n')}
  </dict>
  <key>RunAtLoad</key><true/>
  <!-- A parked queue exits when the window is exhausted and its nap is done; relaunch
       so it picks up where it left off. Throttled so a hard-failing config cannot spin. -->
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>${xml(join(LOG_DIR, `${label}.out.log`))}</string>
  <key>StandardErrorPath</key><string>${xml(join(LOG_DIR, `${label}.err.log`))}</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
}

function launchctl(args, { check = true } = {}) {
  try {
    return { ok: true, out: execFileSync('launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (err) {
    if (check) return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}`.trim(), code: err.status };
    throw err;
  }
}

const uid = () => (typeof process.getuid === 'function' ? process.getuid() : 0);

export function install(root, opts = {}) {
  mkdirSync(LAUNCH_AGENTS, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
  const path = plistPath(root);
  // 0600: the plist embeds PATH/HOME and any env the caller passed, and
  // ~/Library/LaunchAgents is world-readable by default.
  writeFileSync(path, buildPlist(root, opts), { mode: 0o600 });
  return { path, label: labelFor(root), logs: LOG_DIR };
}

export function start(root) {
  const path = plistPath(root);
  if (!existsSync(path)) throw new Error(`no agent installed for this repo. Run \`cq daemon install\` first.`);
  // bootout first so `start` is idempotent and picks up a rewritten plist.
  launchctl(['bootout', `gui/${uid()}/${labelFor(root)}`]);
  const r = launchctl(['bootstrap', `gui/${uid()}`, path]);
  if (!r.ok) throw new Error(`launchctl bootstrap failed: ${r.out}`);
  return { label: labelFor(root) };
}

export function stop(root) {
  const r = launchctl(['bootout', `gui/${uid()}/${labelFor(root)}`]);
  // "not loaded" is success for a stop.
  if (!r.ok && !/not (find|loaded)|No such process/i.test(r.out)) {
    throw new Error(`launchctl bootout failed: ${r.out}`);
  }
  return { label: labelFor(root), wasRunning: r.ok };
}

export function uninstall(root) {
  try { stop(root); } catch { /* stopping a non-running agent is fine */ }
  const path = plistPath(root);
  if (existsSync(path)) { unlinkSync(path); return { removed: path }; }
  return { removed: null };
}

export function status(root) {
  const label = labelFor(root);
  const path = plistPath(root);
  const r = launchctl(['print', `gui/${uid()}/${label}`]);
  const info = { label, plist: path, installed: existsSync(path), loaded: r.ok, pid: null, lastExit: null };
  if (r.ok) {
    info.pid = Number(/\bpid = (\d+)/.exec(r.out)?.[1]) || null;
    info.lastExit = /last exit code = (\d+)/.exec(r.out)?.[1] ?? null;
  }
  info.logOut = join(LOG_DIR, `${label}.out.log`);
  info.logErr = join(LOG_DIR, `${label}.err.log`);
  return info;
}

export function tailLog(path, lines = 40) {
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf8').split('\n').slice(-lines).join('\n');
}

/**
 * The equivalent systemd unit, printed rather than installed off darwin. Writing to a
 * user's systemd config from a tool whose tests never run there would be overreach.
 */
export function systemdUnit(root, { nodeBin = process.execPath, cliPath } = {}) {
  return `# ~/.config/systemd/user/cq-${basename(resolve(root))}.service
[Unit]
Description=cq queue for ${resolve(root)}

[Service]
Type=simple
WorkingDirectory=${resolve(root)}
ExecStart=${nodeBin} ${cliPath} run
Restart=always
RestartSec=60

[Install]
WantedBy=default.target

# systemctl --user daemon-reload && systemctl --user enable --now cq-${basename(resolve(root))}
`;
}
