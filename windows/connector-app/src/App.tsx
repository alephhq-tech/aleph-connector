import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { type DetectedAgent } from "./api";

const ABSOLUTE_PATH_RE = /(?:[A-Za-z]:[\\/]|\\\\)[^\s"'`<>|)]+/g;

function scrubPaths(text: string): string {
  return text.replace(ABSOLUTE_PATH_RE, "…");
}

type Nav = "autocad" | "agents" | "logs";
type BusyAction =
  | "install"
  | "uninstall"
  | "check"
  | "update"
  | "mcp"
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
  const [nav, setNav] = useState<Nav>("autocad");
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
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [confirmUpdate, setConfirmUpdate] = useState(false);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startupRequested = useRef(false);

  useEffect(() => {
    return () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    };
  }, []);

  const showNotice = useCallback((kind: NoticeKind, title: string, detail?: string) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice({ kind, title, detail: detail ? scrubPaths(detail) : undefined });
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
    const clean = scrubPaths(line);
    setLog((prev) => (prev ? `${prev}\n\n${clean}` : clean));
  }, []);

  const refreshAgents = useCallback(async () => {
    const list = await invoke<DetectedAgent[]>("detect_agents");
    setAgents(list);
    setStatus(`Đã tìm thấy ${list.filter((a) => a.present).length} tác nhân trên máy này.`);
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
    setUpdateError(null);
    try {
      const info = await invoke<UpdateCheck>("check_updates");
      setUpdateInfo(info);
      return { info, error: null };
    } catch (e) {
      const error = scrubPaths(String(e));
      setUpdateInfo(null);
      setUpdateError(error);
      return { info: null, error };
    }
  }, []);

  useEffect(() => {
    if (nav !== "autocad") return;
    void refreshIntegration();
    void refreshUpdates();
  }, [nav, refreshIntegration, refreshRuntime, refreshUpdates]);

  useEffect(() => {
    void (async () => {
      try {
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
        showNotice("err", "Runtime khởi động thất bại", message);
      });
  }, [showNotice]);

  async function onInstallAutocad() {
    beginBusy("install");
    showNotice("info", "Đang cài Bridge + plugin…", "Trỏ Bridge đến runtime cục bộ.");
    try {
      const deviceWssUrl = runtime?.deviceWssUrl ?? "ws://127.0.0.1:8080/device";
      // The runtime owns identity.json; install.ps1 reads the credential from disk.
      const [ok, out] = await invoke<[boolean, string]>("install_autocad", {
        deviceGatewayUrl: deviceWssUrl,
        deviceId: null,
        deviceToken: null,
        tokenExpiresAt: null,
      });
      appendLog(out || "(không có đầu ra)");
      await refreshIntegration();
      await refreshUpdates();
      if (ok) {
        setStatus("Tích hợp AutoCAD đã cài.");
        showNotice("ok", "Cài đặt hoàn tất", "Bridge và plugin CadAI đã sẵn sàng.");
      } else {
        setStatus("Cài đặt AutoCAD thất bại — xem Nhật ký.");
        showNotice("err", "Cài đặt thất bại", out.slice(0, 240) || "Mở Nhật ký để xem toàn bộ đầu ra PowerShell.");
        setNav("logs");
      }
    } catch (e) {
      const msg = String(e);
      setError(msg);
      showNotice("err", "Cài đặt thất bại", msg);
    } finally {
      endBusy();
    }
  }

  async function onUninstallAutocad() {
    if (!window.confirm("Gỡ Bridge và plugin CadAI khỏi máy này?")) return;
    beginBusy("uninstall");
    showNotice("info", "Đang gỡ…");
    try {
      const [ok, out] = await invoke<[boolean, string]>("uninstall_autocad");
      appendLog(out || "(không có đầu ra)");
      await refreshIntegration();
      await refreshUpdates();
      if (ok) {
        setStatus("Tích hợp AutoCAD đã gỡ.");
        showNotice("ok", "Đã gỡ cài đặt", "Bridge và plugin đã được gỡ khỏi máy này.");
      } else {
        setStatus("Gỡ cài đặt thất bại — xem Nhật ký.");
        showNotice("err", "Gỡ cài đặt thất bại", "Mở Nhật ký để xem chi tiết.");
        setNav("logs");
      }
    } catch (e) {
      const msg = String(e);
      setError(msg);
      showNotice("err", "Gỡ cài đặt thất bại", msg);
    } finally {
      endBusy();
    }
  }

  async function onCheckUpdates() {
    beginBusy("check");
    setConfirmUpdate(false);
    showNotice("info", "Đang kiểm tra kênh cập nhật…");
    try {
      const { info, error } = await refreshUpdates();
      if (error || !info) {
        showNotice("err", "Kiểm tra cập nhật thất bại", error ?? undefined);
        return;
      }
      setStatus(info.message);
      if (info.updateAvailable) {
        showNotice("ok", `Có bản cập nhật ${info.latest}`, info.message);
      } else if (info.channelAvailable) {
        showNotice("ok", "Đã cập nhật", info.message);
      } else {
        showNotice("info", "Kênh trống", info.message);
      }
    } catch (e) {
      const msg = String(e);
      setError(msg);
      showNotice("err", "Kiểm tra cập nhật thất bại", msg);
    } finally {
      endBusy();
    }
  }

  async function onApplyUpdate() {
    if (!confirmUpdate) {
      setConfirmUpdate(true);
      showNotice("info", "Bấm Cập nhật lần nữa để xác nhận", "File cài đặt đã xác minh sẽ mở; làm theo hướng dẫn và đóng Connector khi được yêu cầu.");
      return;
    }
    setConfirmUpdate(false);
    beginBusy("update");
    showNotice("info", "Đang tải cập nhật…", "Đang xác minh bản phát hành có chữ ký trước khi chạy file cài đặt.");
    try {
      await invoke<void>("apply_update");
      setStatus("File cài đặt đã xác minh đã mở. Làm theo hướng dẫn để hoàn tất cập nhật.");
    } catch (e) {
      const msg = String(e);
      setError(msg);
      showNotice("err", "Cập nhật thất bại", msg);
    } finally {
      endBusy();
    }
  }

  async function onInstallPlugin() {
    beginBusy("mcp");
    try {
      const selected = agents.filter((a) => a.selected);
      if (selected.length === 0) {
        const msg = "Chưa chọn tác nhân nào.";
        setStatus(msg);
        showNotice("info", "Không có gì để cài", msg);
        return;
      }
      const mcpUrl = runtime?.mcpUrl ?? "http://127.0.0.1:8080/mcp";
      const stdioExe = selected.some((a) => a.kind === "claudeDesktop")
        ? await invoke<string>("stdio_exe")
        : null;
      for (const agent of selected) {
        await invoke<string>("write_mcp_config", {
          kind: agent.kind,
          configPath: agent.configPath,
          mcpUrl,
          stdioExe,
        });
        appendLog(`MCP → ${agent.displayName}`);
      }
      const packResults = await invoke<
        { kind: string; paths: string[] }[]
      >("install_agent_pack", {
        kinds: selected.map((a) => a.kind),
      });
      for (const r of packResults) {
        appendLog(`Skills → ${r.kind}: ${r.paths.length} đường dẫn`);
      }
      const msg = `Đã cài plugin (MCP + skills) cho ${selected.length} tác nhân.`;
      setStatus(msg);
      showNotice("ok", "Plugin đã cài", msg);
    } catch (e) {
      const msg = String(e);
      setError(msg);
      showNotice("err", "Cài plugin thất bại", msg);
    } finally {
      endBusy();
    }
  }

  const busyLabel =
    busyAction === "install"
      ? "Đang cài đặt…"
      : busyAction === "uninstall"
        ? "Đang gỡ…"
        : busyAction === "check"
          ? "Đang kiểm tra…"
          : busyAction === "update"
            ? "Đang cập nhật…"
            : busyAction === "mcp"
              ? "Đang cài plugin…"
              : busy
                ? "Đang xử lý…"
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
              ["autocad", "AutoCAD"],
              ["agents", "Tác nhân"],
              ["logs", "Nhật ký"],
            ] as const
          ).map(([id, label]) => (
            <button key={id} className={nav === id ? "active" : ""} onClick={() => setNav(id)}>
              {label}
            </button>
          ))}
        </nav>
      </aside>
      <main className="main">
        {notice ? (
          <div className={`toast toast-${notice.kind}`} role="status">
            <div className="toast-body">
              <strong>{notice.title}</strong>
              {notice.detail ? <span>{notice.detail}</span> : null}
            </div>
            <button className="toast-close" type="button" onClick={() => setNotice(null)} aria-label="Đóng">
              ×
            </button>
          </div>
        ) : null}
        {nav === "autocad" && (
          <>
            <h2 className="section-title">AutoCAD</h2>
            <p className="section-lead">
              Cài đặt Bridge không giao diện và plugin CadAI. Bridge gọi runtime cục bộ qua
              loopback; bản phát hành được công bố lên kênh cập nhật Connector.
            </p>

            <div className="status-panel">
              <div className="status-row">
                <span className="status-label">Trạng thái</span>
                <span className={`badge ${integration?.installed ? "ok" : ""}`}>
                  {integration?.installed
                    ? "Đã cài"
                    : integration?.bridgeInstalled || integration?.pluginInstalled
                      ? "Một phần"
                      : "Chưa cài"}
                </span>
              </div>
              <div className="status-row">
                <span className="status-label">Bridge</span>
                <span className="status-value">
                  {integration?.bridgeInstalled
                    ? integration.bridgeVersion || "có"
                    : "thiếu"}
                </span>
              </div>
              <div className="status-row">
                <span className="status-label">Plugin</span>
                <span className="status-value">
                  {integration?.pluginInstalled
                    ? integration.pluginVersion || "có"
                    : "thiếu"}
                </span>
              </div>
              <div className="status-row">
                <span className="status-label">Connector</span>
                <span className="status-value">{integration?.connectorVersion ?? "…"}</span>
              </div>
              <div className="status-row">
                <span className="status-label">Cập nhật</span>
                <span className={`badge ${updateError ? "warn" : updateInfo?.updateAvailable ? "warn" : updateInfo?.channelAvailable ? "ok" : ""}`}>
                  {updateError
                    ? "Lỗi kiểm tra"
                    : updateInfo?.updateAvailable
                      ? `Cập nhật đến ${updateInfo.latest}`
                      : updateInfo?.channelAvailable
                        ? "Đã cập nhật"
                        : "Kênh trống"}
                </span>
              </div>
              {updateError ? (
                <p className="status-msg">{updateError}</p>
              ) : updateInfo?.message ? (
                <p className="status-msg">{scrubPaths(updateInfo.message)}</p>
              ) : null}
            </div>

            {busyLabel && (busyAction === "install" || busyAction === "update" || busyAction === "uninstall" || busyAction === "check") ? (
              <div className="loading-banner" aria-live="polite">
                <span className="spinner" aria-hidden="true" />
                <div>
                  <strong>{busyLabel}</strong>
                  <p>
                    {busyAction === "install"
                      ? "Đang chạy install.ps1 — giữ cửa sổ này mở."
                      : busyAction === "update"
                        ? "Đang tải và kiểm tra file cài đặt có chữ ký."
                      : busyAction === "check"
                        ? "Đang lấy manifest bản phát hành của Aleph Connector."
                        : "Đang gỡ Bridge và plugin."}
                  </p>
                </div>
              </div>
            ) : null}

            {integration?.installed &&
            (integration.bridgeVersion !== integration.connectorVersion || integration.pluginVersion !== integration.connectorVersion) ? (
              <p className="status-msg">Phiên bản Bridge hoặc plugin khác với Connector. Đóng AutoCAD rồi chọn Sửa chữa / cài lại để áp dụng tích hợp kèm theo.</p>
            ) : null}
            {!runtime?.healthy ? <p className="status-msg">Khởi động runtime cục bộ trước khi cài đặt hoặc sửa chữa tích hợp AutoCAD.</p> : null}
            <div className="actions">
              {updateInfo?.updateAvailable ? (
                <button
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => void onApplyUpdate()}
                >
                  {busyAction === "update"
                    ? "Đang cập nhật…"
                    : confirmUpdate
                      ? `Xác nhận cập nhật đến ${updateInfo.latest}`
                      : `Cập nhật đến ${updateInfo.latest}`}
                </button>
              ) : null}
              <button className="btn btn-primary" disabled={busy || !runtime?.healthy} onClick={() => void onInstallAutocad()}>
                {busyAction === "install"
                  ? "Đang cài đặt…"
                  : integration?.installed
                    ? "Sửa chữa / cài lại"
                    : "Cài Bridge + plugin"}
              </button>
              <button className="btn" disabled={busy} onClick={() => void onCheckUpdates()}>
                {busyAction === "check" ? "Đang kiểm tra…" : "Kiểm tra cập nhật"}
              </button>
              <button
                className="btn btn-danger"
                disabled={busy || !(integration?.bridgeInstalled || integration?.pluginInstalled)}
                onClick={() => void onUninstallAutocad()}
              >
                {busyAction === "uninstall" ? "Đang gỡ…" : "Gỡ cài đặt"}
              </button>
            </div>
          </>
        )}
        {nav === "agents" && (
          <>
            <h2 className="section-title">Tác nhân</h2>
            <p className="section-lead">
              Chọn các client trên máy này. Cài plugin ghi cấu hình MCP trỏ đến runtime cục bộ
              và triển khai skill drafting + PCCC (AGENTS.md).
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
                  </div>
                  <span className={`badge ${agent.present ? "ok" : ""}`}>
                    {agent.present ? "Tìm thấy" : "Thiếu"}
                  </span>
                </label>
              ))}
            </div>
            <div className="actions">
              <button className="btn btn-primary" disabled={busy} onClick={() => void onInstallPlugin()}>
                Cài plugin
              </button>
              <button className="btn" disabled={busy} onClick={() => void refreshAgents()}>
                Làm mới
              </button>
            </div>
          </>
        )}
        {nav === "logs" && (
          <>
            <h2 className="section-title">Nhật ký</h2>
            <p className="section-lead">{status || "Hoạt động từ runtime, cài đặt và thiết lập plugin."}</p>
            <div className="log">{log || "Chưa có đầu ra log."}</div>
          </>
        )}
        {error ? (
          <p className="error" style={{ marginTop: 16 }}>
            {scrubPaths(error)}
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
