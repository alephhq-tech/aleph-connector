import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { open } from "@tauri-apps/plugin-shell";
import {
  approveOAuth,
  asEpochMs,
  googleStartUrl,
  pairDevice,
  signIn,
  signUp,
  type AuthSession,
  type DetectedAgent,
} from "./api";

type Nav = "account" | "autocad" | "agents" | "logs";
type BusyAction = "install" | "uninstall" | "check" | "update" | "pair" | "mcp" | null;
type NoticeKind = "ok" | "err" | "info";

interface Notice {
  kind: NoticeKind;
  title: string;
  detail?: string;
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

function deriveDeviceWss(mcpUrl: string): string {
  try {
    const u = new URL(mcpUrl);
    u.protocol = u.protocol === "http:" ? "ws:" : "wss:";
    u.pathname = "/device";
    u.search = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return "ws://127.0.0.1:8080/device";
  }
}

export default function App() {
  const [gatewayUrl, setGatewayUrl] = useState("http://127.0.0.1:8090");
  const [mcpUrl, setMcpUrl] = useState("http://127.0.0.1:8080/mcp");
  const [session, setSession] = useState<AuthSession | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showEmail, setShowEmail] = useState(false);
  const [nav, setNav] = useState<Nav>("agents");
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
  const gatewayUrlRef = useRef(gatewayUrl);
  const sessionRef = useRef(session);
  const handledAuthTokens = useRef(new Set<string>());
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    gatewayUrlRef.current = gatewayUrl;
  }, [gatewayUrl]);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);
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
    if (nav !== "autocad") return;
    void refreshIntegration();
    void refreshUpdates();
  }, [nav, refreshIntegration, refreshUpdates]);

  const completePair = useCallback(
    async (sess: AuthSession, gw: string) => {
      const deviceId = await invoke<string>("ensure_device_id");
      const paired = await pairDevice(gw, sess.sessionToken, deviceId);
      const expiresAt = asEpochMs(paired.expiresAt);
      await invoke("write_identity", {
        deviceId: paired.deviceId,
        token: paired.token,
        expiresAt,
      });
      appendLog(`Paired ${paired.deviceId}`);
      return {
        deviceId: paired.deviceId,
        token: paired.token,
        expiresAt,
      };
    },
    [appendLog],
  );

  const applySession = useCallback(
    async (sess: AuthSession, gw = gatewayUrlRef.current) => {
      await invoke("save_session", { session: sess });
      setSession(sess);
      setError("");
      setNav("agents");
      try {
        await completePair(sess, gw);
        setStatus("Signed in and device paired.");
      } catch (e) {
        setError(String(e));
        setStatus("Signed in — device pairing needs retry.");
      }
      await refreshAgents();
    },
    [completePair, refreshAgents],
  );

  const handleDeepLink = useCallback(
    async (url: string) => {
      appendLog(`Deep link: ${url}`);
      const gw = gatewayUrlRef.current;
      try {
        const parsed = new URL(url);
        if (url.includes("auth/callback")) {
          const token = parsed.searchParams.get("session_token");
          if (!token) throw new Error("Missing session_token");
          if (handledAuthTokens.current.has(token)) return;
          handledAuthTokens.current.add(token);
          setStatus("Finishing Google sign-in…");
          const me = await fetch(`${gw}/auth/me`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          const body = (await me.json()) as {
            user: { id: string; email: string };
            workspaceId: string;
            workspaceName: string;
            expiresAt: number | string;
            error?: string;
          };
          if (!me.ok) throw new Error(body.error || "Session invalid");
          await applySession(
            {
              sessionToken: token,
              expiresAt: asEpochMs(body.expiresAt),
              user: body.user,
              workspaceId: body.workspaceId,
              workspaceName: body.workspaceName,
            },
            gw,
          );
          return;
        }
        if (url.includes("consent") || url.includes("oauth")) {
          const returnTo = parsed.searchParams.get("return_to");
          const sess = sessionRef.current;
          if (!returnTo || !sess) {
            setError("Sign in first, then approve MCP again.");
            return;
          }
          const authUrl = new URL(returnTo);
          const params: Record<string, string> = {
            client_id: authUrl.searchParams.get("client_id") || "",
            redirect_uri: authUrl.searchParams.get("redirect_uri") || "",
            code_challenge: authUrl.searchParams.get("code_challenge") || "",
          };
          for (const key of ["scope", "resource", "state"]) {
            const v = authUrl.searchParams.get(key);
            if (v) params[key] = v;
          }
          const approved = await approveOAuth(gw, sess.sessionToken, params);
          if (approved.redirect_to) await open(approved.redirect_to);
          setStatus("MCP access approved.");
        }
      } catch (e) {
        setError(String(e));
      }
    },
    [appendLog, applySession],
  );

  useEffect(() => {
    void (async () => {
      try {
        const [gw, mcp] = await invoke<[string, string]>("default_urls");
        setGatewayUrl(gw);
        gatewayUrlRef.current = gw;
        setMcpUrl(mcp);
        const root = await invoke<string>("package_root");
        appendLog(`Package root: ${root}`);
        const existing = await invoke<AuthSession | null>("load_session");
        if (existing) {
          setSession(existing);
          setStatus(`Signed in as ${existing.user.email}`);
          try {
            await completePair(existing, gw);
            setStatus(`Signed in as ${existing.user.email} · device paired`);
          } catch (pairErr) {
            setError(String(pairErr));
            setStatus(`Signed in as ${existing.user.email} — device pairing needs retry`);
          }
        }
        await refreshAgents();
        await refreshIntegration();
        await refreshUpdates();
      } catch (e) {
        setError(String(e));
      }
    })();
  }, [appendLog, completePair, refreshAgents, refreshIntegration, refreshUpdates]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const current = await getCurrent();
        if (!cancelled && current?.length) {
          for (const url of current) await handleDeepLink(url);
        }
        unlisten = await onOpenUrl((urls) => {
          for (const url of urls) void handleDeepLink(url);
        });
      } catch (e) {
        appendLog(`Deep-link listener: ${String(e)}`);
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [appendLog, handleDeepLink]);

  async function onAuth(mode: "signin" | "signup") {
    setBusy(true);
    setError("");
    try {
      const sess =
        mode === "signup"
          ? await signUp(gatewayUrl, email, password)
          : await signIn(gatewayUrl, email, password);
      await applySession(sess);
      setPassword("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onGoogle() {
    setError("");
    await open(googleStartUrl(gatewayUrl));
    setStatus("Complete Google sign-in in the browser…");
  }

  async function onSignOut() {
    await invoke("clear_session");
    setSession(null);
    setStatus("Signed out.");
  }

  async function onInstallAutocad() {
    if (!session) {
      showNotice("err", "Sign in required", "Sign in before installing Bridge.");
      return;
    }
    beginBusy("install");
    showNotice("info", "Installing Bridge + plugin…", "Pairing device, then running install.ps1.");
    try {
      // identity.json may be missing after a local wipe — pair again before install.
      const paired = await completePair(session, gatewayUrlRef.current);
      const [ok, out] = await invoke<[boolean, string]>("install_autocad", {
        deviceGatewayUrl: deriveDeviceWss(mcpUrl),
        deviceId: paired.deviceId,
        deviceToken: paired.token,
        tokenExpiresAt: paired.expiresAt,
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
      showNotice("info", "Click Update again to confirm");
      return;
    }
    setConfirmUpdate(false);
    beginBusy("update");
    showNotice("info", "Downloading and installing update…", "Verifying package hash, then running install.ps1.");
    try {
      const [ok, out] = await invoke<[boolean, string]>("apply_update", {
        deviceGatewayUrl: deriveDeviceWss(mcpUrl),
      });
      appendLog(out || "(no output)");
      await refreshIntegration();
      await refreshUpdates();
      if (ok) {
        setStatus("Update applied.");
        showNotice("ok", "Update complete", "Bridge / plugin package installed.");
      } else {
        setStatus("Update failed — see logs.");
        showNotice("err", "Update failed", "Open Logs for the full output.");
        setNav("logs");
      }
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
      for (const agent of selected) {
        const path = await invoke<string>("write_mcp_config", {
          kind: agent.kind,
          configPath: agent.configPath,
          mcpUrl,
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
      const msg = `Installed plugin (MCP + skills) for ${selected.length} agent(s). OAuth opens Aleph Connector to approve.`;
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
              : busy
                ? "Working…"
                : null;

  if (!session) {
    return (
      <div className="signed-out">
        <div className="signed-out-panel">
          <div className="brand">
            Aleph <span>Connector</span>
          </div>
          <h1>Connect your agents to AutoCAD</h1>
          <p className="lead">
            Sign in once. Install the Bridge and plugin, then wire Cursor, Claude, or VS Code to
            Aleph MCP.
          </p>
          <button className="btn btn-primary btn-google" onClick={() => void onGoogle()} disabled={busy}>
            Continue with Google
          </button>
          <div className="divider">or email</div>
          {!showEmail ? (
            <button className="linkish" onClick={() => setShowEmail(true)}>
              Use email and password
            </button>
          ) : (
            <>
              <div className="field">
                <label htmlFor="email">Email</label>
                <input
                  id="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                />
              </div>
              <div className="field">
                <label htmlFor="password">Password</label>
                <input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                />
              </div>
              <div className="row">
                <button className="btn btn-primary" disabled={busy} onClick={() => void onAuth("signin")}>
                  Sign in
                </button>
                <button className="btn" disabled={busy} onClick={() => void onAuth("signup")}>
                  Sign up
                </button>
              </div>
            </>
          )}
          {error ? <p className="error">{error}</p> : null}
          {status ? <p className="muted">{status}</p> : null}
          <p className="muted">Gateway {gatewayUrl}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          Aleph <span>Connector</span>
        </div>
        <nav className="nav">
          {(
            [
              ["account", "Account"],
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
        <div className="account-chip">
          {session.user.email}
          <div>
            <button className="linkish" onClick={() => void onSignOut()}>
              Sign out
            </button>
          </div>
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
        {nav === "account" && (
          <>
            <h2 className="section-title">Account</h2>
            <p className="section-lead">
              Signed in to {session.workspaceName}. Device credentials are stored under LocalAppData
              CadAI.
            </p>
            <div className="field">
              <label>Gateway URL</label>
              <input value={gatewayUrl} onChange={(e) => setGatewayUrl(e.target.value)} />
            </div>
            <div className="field" style={{ marginTop: 12 }}>
              <label>MCP URL</label>
              <input value={mcpUrl} onChange={(e) => setMcpUrl(e.target.value)} />
            </div>
          </>
        )}
        {nav === "autocad" && (
          <>
            <h2 className="section-title">AutoCAD</h2>
            <p className="section-lead">
              Install the headless Bridge and CadAI plugin. Releases publish to the Aleph
              Connector update channel — Connector detects them and can update in place.
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
                    {busyAction === "install" || busyAction === "update"
                      ? "Running install.ps1 — keep this window open."
                      : busyAction === "check"
                        ? "Fetching the Aleph Connector release manifest."
                        : "Removing Bridge and plugin."}
                  </p>
                </div>
              </div>
            ) : null}

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
              <button className="btn btn-primary" disabled={busy} onClick={() => void onInstallAutocad()}>
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
              Select clients on this machine. Install Plugin writes MCP config and deploys drafting +
              PCCC skills (AGENTS.md). OAuth completes inside Connector.
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
            <p className="section-lead">{status || "Activity from installs and pairing."}</p>
            <div className="log">{log || "No log output yet."}</div>
          </>
        )}
        {error ? (
          <p className="error" style={{ marginTop: 16 }}>
            {error}
            {/pair|device|grant/i.test(error) ? (
              <>
                {" "}
                <button
                  className="linkish"
                  disabled={busy}
                  onClick={() => {
                    if (!session) return;
                    beginBusy("pair");
                    void completePair(session, gatewayUrlRef.current)
                      .then(() => {
                        setError("");
                        setStatus("Device paired.");
                        showNotice("ok", "Device paired");
                      })
                      .catch((e) => {
                        const msg = String(e);
                        setError(msg);
                        showNotice("err", "Pair failed", msg);
                      })
                      .finally(() => endBusy());
                  }}
                >
                  Retry pair
                </button>
              </>
            ) : null}
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
