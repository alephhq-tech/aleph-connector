import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { type DetectedAgent } from "./api";

type Nav = "runtime" | "autocad" | "agents" | "logs";
type BusyAction =
  | "install"
  | "uninstall"
  | "check"
  | "update"
  | "mcp"
  | "start"
  | "stop"
  | "restart"
  | null;
type NoticeKind = "ok" | "err" | "info";

interface Notice {
  kind: NoticeKind;
  title: string;
  detail?: string;
}

interface RuntimeStatus {
  running: boolean;
  port: number;
  mcpUrl: string;
  deviceWssUrl: string;
  healthy: boolean;
}

interface IntegrationStatus {
  installed: boolean;
  bridgeInstalled: boolean;
  pluginInstalled: boolean;
  bridgeVersion: string | null;
  pluginVersion: string | null;
  connectorVersion: string;
  bridgePath: string;
  pluginPath: string;
}

interface UpdateCheck {
  updateAvailable: boolean;
  channelAvailable: boolean;
  latest: string | null;
  current: string;
  packageUrl: string | null;
  message: string;
}

export default function App() {
  const [nav, setNav] = useState<Nav>("runtime");
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [agents, setAgents] = useState<DetectedAgent[]>([]);

  const [log, setLog] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [integration, setIntegration] = useState<IntegrationStatus | null>(null);
  const [updateInfo, setUpdateInfo] = useState<UpdateCheck | null>(null);
  const [confirmUpdate, setConfirmUpdate] = useState(false);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startupRequested = useRef(false);
  const [startupPending, setStartupPending] = useState(true);

  useEffect(() => {
    return () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    };
  }, []);

  const showNotice = useCallback((kind: NoticeKind, title: string, detail?: string) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice({ kind, title, detail });
    noticeTimer.current = setTimeout(() => setNotice(null), kind === "err" ? 10000 : 5500);
  }, []);

  const beginBusy = useCallback((action: BusyAction) => {
    setBusy(true);
    setBusyAction(action);
    setError("");
  }, []);

  const endBusy = useCallback(() => {
    setBusy(false);
    setBusyAction(null);
  }, []);

  const appendLog = useCallback((line: string) => {
    setLog((prev) => (prev ? `${prev}\n\n${line}` : line));
  }, []);

  const refreshAgents = useCallback(async () => {
    const list = await invoke<DetectedAgent[]>("detect_agents");
    setAgents(list);
    setStatus(`Found ${list.filter((a) => a.present).length} agent(s) on this machine.`);
  }, []);

  const refreshIntegration = useCallback(async () => {
    const st = await invoke<IntegrationStatus>("integration_status");
    setIntegration(st);
    return st;
  }, []);

  const refreshRuntime = useCallback(async () => {
    const st = await invoke<RuntimeStatus>("runtime_status");
    setRuntime(st);
    return st;
  }, []);

  const refreshUpdates = useCallback(async () => {
    try {
      const info = await invoke<UpdateCheck>("check_updates");
      setUpdateInfo(info);
      return info;
    } catch (e) {
      setUpdateInfo({
        updateAvailable: false,
        channelAvailable: false,
        latest: null,
        current: integration?.bridgeVersion || integration?.connectorVersion || "?",
        packageUrl: null,
        message: String(e),
      });
      return null;
    }
  }, [integration?.bridgeVersion, integration?.connectorVersion]);

  useEffect(() => {
    if (nav === "runtime") void refreshRuntime();
    if (nav !== "autocad") return;
    void refreshIntegration();
    void refreshUpdates();
  }, [nav, refreshIntegration, refreshRuntime, refreshUpdates]);

  useEffect(() => {
    void (async () => {
      try {
        const root = await invoke<string>("package_root");

        appendLog(`Package root: ${root}`);
        await refreshRuntime();
        await refreshAgents();
        await refreshIntegration();
        await refreshUpdates();
      } catch (e) {
        setError(String(e));
      }
    })();
  }, [appendLog, refreshAgents, refreshIntegration, refreshRuntime, refreshUpdates]);

  useEffect(() => {
    const timer = setInterval(() => {
      void refreshRuntime().catch((e) => setError(String(e)));
    }, 2000);
    return () => clearInterval(timer);
  }, [refreshRuntime]);

  useEffect(() => {
    if (startupRequested.current) return;
    startupRequested.current = true;
    void invoke<RuntimeStatus>("start_runtime", { port: null })
      .then(setRuntime)
      .catch((e) => {
        const message = String(e);
        setError(message);
        showNotice("err", "Runtime failed to start", message);
      })
      .finally(() => setStartupPending(false));
  }, [showNotice]);

  async function onStartRuntime() {
    beginBusy("start");
    try {
      const st = await invoke<RuntimeStatus>("start_runtime", { port: null });
      setRuntime(st);
      appendLog(`Runtime started on port ${st.port}`);
      if (st.healthy) {
        setStatus(`Local MCP running on port ${st.port}.`);
        showNotice("ok", "Runtime started", st.mcpUrl);
      } else {
        setStatus("Runtime started but /health is not answering yet.");
        showNotice("info", "Runtime starting", "Health check pending.");
      }
    } catch (e) {
      const msg = String(e);
      setError(msg);
      showNotice("err", "Runtime failed to start", msg);
    } finally {
      endBusy();
    }
  }

  async function onStopRuntime() {
    beginBusy("stop");
    try {
      const st = await invoke<RuntimeStatus>("stop_runtime");
      setRuntime(st);
      appendLog("Runtime stopped");
      setStatus("Local MCP stopped.");
      showNotice("info", "Runtime stopped");
    } catch (e) {
      const msg = String(e);
      setError(msg);
      showNotice("err", "Stop failed", msg);
    } finally {
      endBusy();
    }
  }

  async function onRestartRuntime() {
    beginBusy("restart");
    try {
      await invoke<RuntimeStatus>("stop_runtime");
      const st = await invoke<RuntimeStatus>("start_runtime", { port: null });
      setRuntime(st);
      appendLog(`Runtime restarted on port ${st.port}`);
      setStatus(`Local MCP running on port ${st.port}.`);
      showNotice("ok", "Runtime restarted", st.mcpUrl);
    } catch (e) {
      const msg = String(e);
      setError(msg);
      showNotice("err", "Restart failed", msg);
    } finally {
      endBusy();
    }
  }

  async function onInstallAutocad() {
    beginBusy("install");
    showNotice("info", "Installing Bridge + plugin…", "Pointing the Bridge at the local runtime.");
    try {
      const deviceWssUrl = runtime?.deviceWssUrl ?? "ws://127.0.0.1:8080/device";
      // The runtime owns identity.json; install.ps1 reads the credential from disk.
      const [ok, out] = await invoke<[boolean, string]>("install_autocad", {
        deviceGatewayUrl: deviceWssUrl,
        deviceId: null,
        deviceToken: null,
        tokenExpiresAt: null,
      });
      appendLog(out || "(no output)");
      await refreshIntegration();
      await refreshUpdates();
      if (ok) {
        setStatus("AutoCAD integration installed.");
        showNotice("ok", "Install complete", "Bridge and CadAI plugin are ready.");
      } else {
        setStatus("AutoCAD install failed — see logs.");
        showNotice("err", "Install failed", out.slice(0, 240) || "Open Logs for the full PowerShell output.");
        setNav("logs");
      }
    } catch (e) {
      const msg = String(e);
      setError(msg);
      showNotice("err", "Install failed", msg);
    } finally {
      endBusy();
    }
  }

  async function onUninstallAutocad() {
    if (!window.confirm("Uninstall Bridge and CadAI plugin from this machine?")) return;
    beginBusy("uninstall");
    showNotice("info", "Uninstalling…");
    try {
      const [ok, out] = await invoke<[boolean, string]>("uninstall_autocad");
      appendLog(out || "(no output)");
      await refreshIntegration();
      await refreshUpdates();
      if (ok) {
        setStatus("AutoCAD integration uninstalled.");
        showNotice("ok", "Uninstalled", "Bridge and plugin removed from this machine.");
      } else {
        setStatus("Uninstall failed — see logs.");
        showNotice("err", "Uninstall failed", "Open Logs for details.");
        setNav("logs");
      }
    } catch (e) {
      const msg = String(e);
      setError(msg);
      showNotice("err", "Uninstall failed", msg);
    } finally {
      endBusy();
    }
  }

  async function onCheckUpdates() {
    beginBusy("check");
    setConfirmUpdate(false);
    showNotice("info", "Checking update channel…");
    try {
      const info = await refreshUpdates();
      if (!info) {
        showNotice("err", "Update check failed");
        return;
      }
      setStatus(info.message);
      if (info.updateAvailable) {
        showNotice("ok", `Update ${info.latest} available`, info.message);
      } else if (info.channelAvailable) {
        showNotice("ok", "Up to date", info.message);
      } else {
        showNotice("info", "Channel idle", info.message);
      }
    } catch (e) {
      const msg = String(e);
      setError(msg);
      showNotice("err", "Update check failed", msg);
    } finally {
      endBusy();
    }
  }

  async function onApplyUpdate() {
    if (!confirmUpdate) {
      setConfirmUpdate(true);
      showNotice("info", "Click Update again to confirm", "The verified installer will open; follow its prompts and close Connector when asked.");
      return;
    }
    setConfirmUpdate(false);
    beginBusy("update");
    showNotice("info", "Downloading update…", "Verifying the signed release before launching its installer.");
    try {
      await invoke<void>("apply_update");
      setStatus("Verified installer launched. Follow its prompts to complete the update.");
    } catch (e) {
      const msg = String(e);
      setError(msg);
      showNotice("err", "Update failed", msg);
    } finally {
      endBusy();
    }
  }

  async function onInstallPlugin() {
    beginBusy("mcp");
    try {
      const selected = agents.filter((a) => a.selected);
      if (selected.length === 0) {
        const msg = "No agents selected.";
        setStatus(msg);
        showNotice("info", "Nothing to install", msg);
        return;
      }
      const mcpUrl = runtime?.mcpUrl ?? "http://127.0.0.1:8080/mcp";
      const stdioExe = selected.some((a) => a.kind === "claudeDesktop")
        ? await invoke<string>("stdio_exe")
        : null;
      for (const agent of selected) {
        const path = await invoke<string>("write_mcp_config", {
          kind: agent.kind,
          configPath: agent.configPath,
          mcpUrl,
          stdioExe,
        });
        appendLog(`MCP → ${agent.displayName}: ${path}`);
      }
      const packResults = await invoke<
        { kind: string; paths: string[] }[]
      >("install_agent_pack", {
        kinds: selected.map((a) => a.kind),
      });
      for (const r of packResults) {
        appendLog(`Skills → ${r.kind}: ${r.paths.length} path(s)`);
        for (const p of r.paths.slice(0, 6)) appendLog(`  ${p}`);
      }
      const msg = `Installed plugin (MCP + skills) for ${selected.length} agent(s).`;
      setStatus(msg);
      showNotice("ok", "Plugin installed", msg);
    } catch (e) {
      const msg = String(e);
      setError(msg);
      showNotice("err", "Plugin install failed", msg);
    } finally {
      endBusy();
    }
  }

  const busyLabel =
    busyAction === "install"
      ? "Installing…"
      : busyAction === "uninstall"
        ? "Uninstalling…"
        : busyAction === "check"
          ? "Checking…"
          : busyAction === "update"
            ? "Updating…"
            : busyAction === "mcp"
              ? "Installing plugin…"
              : busyAction === "start"
                ? "Starting runtime…"
                : busyAction === "stop"
                  ? "Stopping runtime…"
                  : busyAction === "restart"
                    ? "Restarting runtime…"
                    : busy
                      ? "Working…"
                      : null;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          Aleph <span>Connector</span>
        </div>
        <nav className="nav">
          {(
            [
              ["runtime", "Runtime"],
              ["autocad", "AutoCAD"],
              ["agents", "Agents"],
              ["logs", "Logs"],
            ] as const
          ).map(([id, label]) => (
            <button key={id} className={nav === id ? "active" : ""} onClick={() => setNav(id)}>
              {label}
            </button>
          ))}
        </nav>
        <div className="runtime-chip">
          <span className={`badge ${runtime?.running && runtime.healthy ? "ok" : ""}`}>
            {runtime?.running ? (runtime.healthy ? "MCP running" : "MCP starting") : "MCP stopped"}
          </span>
        </div>
      </aside>
      <main className="main">
        {notice ? (
          <div className={`toast toast-${notice.kind}`} role="status">
            <div className="toast-body">
              <strong>{notice.title}</strong>
              {notice.detail ? <span>{notice.detail}</span> : null}
            </div>
            <button className="toast-close" type="button" onClick={() => setNotice(null)} aria-label="Dismiss">
              ×
            </button>
          </div>
        ) : null}
        {nav === "runtime" && (
          <>
            <h2 className="section-title">Local runtime</h2>
            <p className="section-lead">
              One local MCP server on this machine — no account, no cloud. Your agents connect to
              the MCP URL below; the Bridge dials the device URL.
            </p>
            <div className="status-panel">
              <div className="status-row">
                <span className="status-label">Local MCP</span>
                <span className={`badge ${runtime?.running && runtime.healthy ? "ok" : ""}`}>
                  {runtime?.running && runtime.healthy
                    ? "Running"
                    : runtime?.running
                      ? "Starting"
                      : "Stopped"}
                </span>
              </div>
              <div className="status-row">
                <span className="status-label">Port</span>
                <span className="status-value">{runtime?.port ?? "—"}</span>
              </div>
              <div className="status-row">
                <span className="status-label">Health</span>
                <span className="status-value">
                  {runtime?.healthy ? "/health ok" : runtime?.running ? "/health pending" : "not running"}
                </span>
              </div>
              <div className="status-row">
                <span className="status-label">MCP URL</span>
                <span className="status-value">{runtime?.mcpUrl ?? "—"}</span>
              </div>
              <div className="status-row">
                <span className="status-label">Bridge WSS</span>
                <span className="status-value">{runtime?.deviceWssUrl ?? "—"}</span>
              </div>
            </div>
            <div className="actions">
              {runtime?.running ? (
                <>
                  <button className="btn" disabled={busy} onClick={() => void onRestartRuntime()}>
                    {busyAction === "restart" ? "Restarting…" : "Restart"}
                  </button>
                  <button className="btn btn-danger" disabled={busy} onClick={() => void onStopRuntime()}>
                    {busyAction === "stop" ? "Stopping…" : "Stop"}
                  </button>
                </>
              ) : (
                <button className="btn btn-primary" disabled={busy || startupPending} onClick={() => void onStartRuntime()}>
                  {busyAction === "start" || startupPending ? "Starting…" : "Start runtime"}
                </button>
              )}
            </div>
          </>
        )}
        {nav === "autocad" && (
          <>
            <h2 className="section-title">AutoCAD</h2>
            <p className="section-lead">
              Install the headless Bridge and CadAI plugin. The Bridge dials the local runtime over
              loopback; releases publish to the Connector update channel.
            </p>

            <div className="status-panel">
              <div className="status-row">
                <span className="status-label">Status</span>
                <span className={`badge ${integration?.installed ? "ok" : ""}`}>
                  {integration?.installed
                    ? "Installed"
                    : integration?.bridgeInstalled || integration?.pluginInstalled
                      ? "Partial"
                      : "Not installed"}
                </span>
              </div>
              <div className="status-row">
                <span className="status-label">Bridge</span>
                <span className="status-value">
                  {integration?.bridgeInstalled
                    ? integration.bridgeVersion || "present"
                    : "missing"}
                </span>
              </div>
              <div className="status-row">
                <span className="status-label">Plugin</span>
                <span className="status-value">
                  {integration?.pluginInstalled
                    ? integration.pluginVersion || "present"
                    : "missing"}
                </span>
              </div>
              <div className="status-row">
                <span className="status-label">Connector</span>
                <span className="status-value">{integration?.connectorVersion ?? "…"}</span>
              </div>
              <div className="status-row">
                <span className="status-label">Updates</span>
                <span className={`badge ${updateInfo?.updateAvailable ? "warn" : updateInfo?.channelAvailable ? "ok" : ""}`}>
                  {updateInfo?.updateAvailable
                    ? `Update ${updateInfo.latest}`
                    : updateInfo?.channelAvailable
                      ? "Up to date"
                      : "Channel idle"}
                </span>
              </div>
              {updateInfo?.message ? (
                <p className="status-msg">{updateInfo.message}</p>
              ) : null}
            </div>

            {busyLabel && (busyAction === "install" || busyAction === "update" || busyAction === "uninstall" || busyAction === "check") ? (
              <div className="loading-banner" aria-live="polite">
                <span className="spinner" aria-hidden="true" />
                <div>
                  <strong>{busyLabel}</strong>
                  <p>
                    {busyAction === "install"
                      ? "Running install.ps1 — keep this window open."
                      : busyAction === "update"
                        ? "Downloading and verifying the signed installer."
                      : busyAction === "check"
                        ? "Fetching the Aleph Connector release manifest."
                        : "Removing Bridge and plugin."}
                  </p>
                </div>
              </div>
            ) : null}

            {integration?.installed &&
            (integration.bridgeVersion !== integration.connectorVersion || integration.pluginVersion !== integration.connectorVersion) ? (
              <p className="status-msg">Bridge or plugin version differs from Connector. Close AutoCAD, then choose Repair / reinstall to apply the bundled integration.</p>
            ) : null}
            {!runtime?.healthy ? <p className="status-msg">Start the local runtime before installing or repairing the AutoCAD integration.</p> : null}
            <div className="actions">
              {updateInfo?.updateAvailable ? (
                <button
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => void onApplyUpdate()}
                >
                  {busyAction === "update"
                    ? "Updating…"
                    : confirmUpdate
                      ? `Confirm update to ${updateInfo.latest}`
                      : `Update to ${updateInfo.latest}`}
                </button>
              ) : null}
              <button className="btn btn-primary" disabled={busy || startupPending || !runtime?.healthy} onClick={() => void onInstallAutocad()}>
                {busyAction === "install"
                  ? "Installing…"
                  : integration?.installed
                    ? "Repair / reinstall"
                    : "Install Bridge + plugin"}
              </button>
              <button className="btn" disabled={busy} onClick={() => void onCheckUpdates()}>
                {busyAction === "check" ? "Checking…" : "Check for updates"}
              </button>
              <button
                className="btn btn-danger"
                disabled={busy || !(integration?.bridgeInstalled || integration?.pluginInstalled)}
                onClick={() => void onUninstallAutocad()}
              >
                {busyAction === "uninstall" ? "Uninstalling…" : "Uninstall"}
              </button>
            </div>
          </>
        )}
        {nav === "agents" && (
          <>
            <h2 className="section-title">Agents</h2>
            <p className="section-lead">
              Select clients on this machine. Install Plugin writes MCP config pointing at the local
              runtime and deploys drafting + PCCC skills (AGENTS.md).
            </p>
            <div className="agent-list">
              {agents.map((agent, idx) => (
                <label key={agent.kind} className="agent-row">
                  <input
                    type="checkbox"
                    checked={agent.selected}
                    onChange={(e) => {
                      const next = [...agents];
                      next[idx] = { ...agent, selected: e.target.checked };
                      setAgents(next);
                    }}
                  />
                  <div>
                    <div className="name">{agent.displayName}</div>
                    <div className="path">{agent.configPath}</div>
                  </div>
                  <span className={`badge ${agent.present ? "ok" : ""}`}>
                    {agent.present ? "Found" : "Missing"}
                  </span>
                </label>
              ))}
            </div>
            <div className="actions">
              <button className="btn btn-primary" disabled={busy} onClick={() => void onInstallPlugin()}>
                Install Plugin
              </button>
              <button className="btn" disabled={busy} onClick={() => void refreshAgents()}>
                Refresh
              </button>
            </div>
          </>
        )}
        {nav === "logs" && (
          <>
            <h2 className="section-title">Logs</h2>
            <p className="section-lead">{status || "Activity from the runtime, installs, and plugin setup."}</p>
            <div className="log">{log || "No log output yet."}</div>
          </>
        )}
        {error ? (
          <p className="error" style={{ marginTop: 16 }}>
            {error}
          </p>
        ) : null}
        {status && nav !== "logs" && !notice ? (
          <p className="muted" style={{ marginTop: 16 }}>
            {status}
          </p>
        ) : null}
      </main>
    </div>
  );
}
