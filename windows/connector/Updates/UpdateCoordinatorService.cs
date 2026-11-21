using System;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text.Json;
using System.Threading;
using System.Net.Http;
using System.Threading.Tasks;
using CadAi.Bridge.Device;
using CadAi.Bridge.Diagnostics;
using CadAi.Updater;
using CadAi.Updater.Verify;

namespace CadAi.Bridge.Updates
{
    /// <summary>
    /// Drives the update state machine from flow_auto_update_version.jpg's "Bridge" branch:
    /// periodically calls <see cref="IUpdateCoordinator.CheckAsync"/>, and on a new release,
    /// downloads/verifies/stages the plugin unconditionally, then either activates it
    /// immediately (no AutoCAD instance running) or defers until
    /// <see cref="AutoCadProcessMonitor.AllInstancesExited"/> fires. Also stages and applies a
    /// Bridge self-update when the release package includes one.
    /// </summary>
    /// <remarks>
    /// <para><b>Design decisions beyond the literal interface (documented per the task's "flag
    /// deviations" instruction):</b></para>
    /// <list type="bullet">
    /// <item><description><b>Single shared version number.</b> <see cref="IUpdateCoordinator"/>
    /// takes one "current version" at construction and one manifest `latest` field covers both
    /// the plugin and an optional Bridge self-update — i.e. this repo ships Bridge+Plugin as one
    /// unified release train. This service constructs its <see cref="UpdateCoordinator"/> with
    /// <see cref="BridgeConfig.BridgeVersion"/>, matching that field's own doc comment example
    /// ("e.g. the Bridge's assembly version").</description></item>
    /// <item><description><b>Pending-activation marker.</b> "Staged but waiting for AutoCAD to
    /// exit" is tracked in memory (<c>_stagedPluginVersion</c>) *and* persisted to
    /// <c>{bundleRoot}/pending-activation.json</c>, because a Bridge self-update replaces and
    /// restarts this very process — without the on-disk marker, a self-update that lands while
    /// AutoCAD is still open would forget the plugin was ever staged. <see cref="Start"/> resumes
    /// from that marker before the first periodic check runs.</description></item>
    /// <item><description><b>Public key policy.</b> Standalone updates are opt-in. Without
    /// a production verifier the loop remains disabled; the checked-in dev key is only accepted
    /// when CADAI_ALLOW_DEV_UPDATER=1 is explicitly enabled. Invalid production key material
    /// disables the updater rather than preventing the Bridge from starting.</description></item>
    /// </list>
    /// </remarks>
    public sealed class UpdateCoordinatorService : IAsyncDisposable
    {
        private static readonly JsonSerializerOptions MarkerJsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
        /// <summary>How often a staged-but-unconfirmed update re-reads its marker from disk.
        /// The Bridge has no UI anymore: confirmation arrives as a marker Aleph Desktop rewrites,
        /// so an hourly manifest check would leave a clicked "Cập nhật" sitting idle for up to an
        /// hour. Only runs while something is actually awaiting confirmation.</summary>
        private static readonly TimeSpan PendingConfirmationPollInterval = TimeSpan.FromSeconds(60);

        private readonly BridgeConfig _config;
        private readonly AutoCadProcessMonitor _processMonitor;
        private readonly IBridgeLogger _logger;
        private readonly UpdateCoordinator _coordinator;
        /// <summary>Manual standalone updates require a production key (or explicit dev opt-in).
        /// Normal customer updates are delivered through the signed Desktop installer.</summary>
        private readonly bool _standaloneUpdatesEnabled;
        private readonly SemaphoreSlim _checkGate = new(1, 1);

        private CancellationTokenSource? _cts;
        private Task? _loop;
        private Task? _confirmationLoop;
        private string? _stagedPluginVersion;
        private string? _stagedSelfUpdatePath;
        private bool _userConfirmed;
        private bool _subscribedToExit;

        public UpdateCoordinatorService(BridgeConfig config, AutoCadProcessMonitor processMonitor, IBridgeLogger logger)
        {
            _config = config;
            _processMonitor = processMonitor;
            _logger = logger;
            bool hasUrl = !string.IsNullOrWhiteSpace(config.UpdateManifestUrl);
            bool hasProductionKey = !string.IsNullOrWhiteSpace(config.UpdaterPublicKeyPath);
            bool devOptIn = Environment.GetEnvironmentVariable("CADAI_ALLOW_DEV_UPDATER") == "1";
            bool standaloneEnabled = hasUrl && (hasProductionKey || devOptIn);
            // An invalid key file must never take the CAD drawing Bridge offline. Disable the
            // optional standalone channel while keeping the signed-Desktop update path alive.
            RSA publicKey;
            try
            {
                publicKey = LoadPublicKey(config, logger);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or CryptographicException or ArgumentException)
            {
                logger.LogError("Cannot load standalone update public key; update checks are disabled until the configuration is fixed.", ex);
                standaloneEnabled = false;
                publicKey = RsaPem.FromPem(DevPublicKey.Pem);
            }
            _standaloneUpdatesEnabled = standaloneEnabled;
            if (hasUrl && !_standaloneUpdatesEnabled)
                logger.LogWarning("Standalone updates disabled: configure a readable production CADAI_UPDATER_PUBLIC_KEY_PATH. CADAI_ALLOW_DEV_UPDATER=1 is for local testing only.");
            _coordinator = new UpdateCoordinator(BridgeConfig.BridgeVersion, publicKey);
        }

        /// <summary>Raised right after a Bridge self-update has been staged and a swap-and-relaunch helper spawned. The subscriber (Program.cs) should shut every other component down gracefully and exit — the helper is waiting for this process to end.</summary>
        public event Action? SelfUpdateStaged;

        /// <summary>
        /// Raised once a new version has been downloaded, verified, and staged, and is waiting for
        /// confirmation before it's actually applied. The Bridge never installs an update nobody
        /// approved — staging alone changes nothing a running AutoCAD or the live Bridge exe can
        /// observe. The Bridge has no UI of its own anymore: `health.json` carries
        /// <see cref="PendingUpdateVersion"/> so Aleph Connector can render the choice, and the user's
        /// answer arrives as a rewritten `pending-activation.json` marker that
        /// <see cref="ConfirmationLoopAsync"/> picks up. Fires again (with the same version) on
        /// every subsequent check while the update remains unconfirmed, and again after a Bridge
        /// restart if it was staged but not yet confirmed beforehand — see
        /// <see cref="ResumePendingActivationFromDisk"/>.
        /// </summary>
        public event Action<string>? UpdateAvailable;

        /// <summary>True when a version is staged and still waiting for confirmation.</summary>
        public bool HasPendingUpdate => _stagedPluginVersion != null && !_userConfirmed;

        /// <summary>The staged-but-not-yet-applied version, or null if none is pending confirmation.</summary>
        public string? PendingUpdateVersion => HasPendingUpdate ? _stagedPluginVersion : null;

        /// <summary>
        /// Applies the already-staged update when confirmation arrives from outside this process:
        /// Aleph Connector rewrites the marker's `confirmed` flag, and the next
        /// <see cref="ConfirmationLoopAsync"/> tick adopts it. Applies through the same safety path
        /// a self-triggered install would use (a Bridge self-update swaps and relaunches
        /// immediately; a plugin update activates at once if AutoCAD isn't running, or waits for it
        /// to close otherwise).
        /// </summary>
        private async Task AdoptConfirmationFromDiskAsync(CancellationToken ct)
        {
            if (_stagedPluginVersion is null || _userConfirmed) return;
            var marker = ReadPendingActivationMarker();
            if (marker is null || !marker.Confirmed || marker.Version != _stagedPluginVersion) return;
            // Same gate the manifest check holds: applying (a self-update swap, or flipping
            // current.json) must never run twice concurrently from the two loops. Bounded wait —
            // a download in progress can hold the gate for a while, and the next poll retries.
            if (!await _checkGate.WaitAsync(TimeSpan.FromMinutes(2), ct).ConfigureAwait(false)) return;
            try
            {
                if (_userConfirmed) return;
                _userConfirmed = true;
                _stagedSelfUpdatePath = marker.SelfUpdatePath;
                _logger.LogInformation($"update to {_stagedPluginVersion} confirmed from Aleph Connector; applying");
                await ApplyConfirmedUpdateAsync(ct).ConfigureAwait(false);
            }
            finally
            {
                _checkGate.Release();
            }
        }

        private string PendingActivationMarkerPath => Path.Combine(_config.BundleRoot, "pending-activation.json");

        public void Start(CancellationToken ct)
        {
            _cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            // A disabled standalone channel must never replay a previously confirmed ZIP
            // after Aleph Desktop installed a newer bundled Bridge and Plugin.
            if (!_standaloneUpdatesEnabled)
            {
                if (File.Exists(PendingActivationMarkerPath))
                    _logger.LogWarning("Ignoring an old standalone update marker: only signed Aleph Connector bundled updates are enabled.");
                return;
            }
            ResumePendingActivationFromDisk();
            if (_stagedPluginVersion != null)
            {
                if (_userConfirmed)
                {
                    _ = ApplyConfirmedUpdateAsync(_cts.Token);
                }
                else
                {
                    UpdateAvailable?.Invoke(_stagedPluginVersion);
                }
            }
            // Confirmation and staging are only meaningful while the standalone channel has
            // an explicitly configured verifier. Desktop controls all normal client updates.
            _confirmationLoop = Task.Run(() => ConfirmationLoopAsync(_cts.Token));
            _loop = Task.Run(() => CheckLoopAsync(_cts.Token));
        }

        private async Task ConfirmationLoopAsync(CancellationToken ct)
        {
            using var timer = new PeriodicTimer(PendingConfirmationPollInterval);
            try
            {
                while (await timer.WaitForNextTickAsync(ct).ConfigureAwait(false))
                {
                    try
                    {
                        if (_stagedPluginVersion is null) continue;
                        if (!_userConfirmed)
                        {
                            await AdoptConfirmationFromDiskAsync(ct).ConfigureAwait(false);
                            continue;
                        }
                        // Re-check confirmed updates after headless AutoCAD Core Console exits.
                        if (!await _checkGate.WaitAsync(0, ct).ConfigureAwait(false)) continue;
                        try { await ApplyConfirmedUpdateAsync(ct).ConfigureAwait(false); }
                        finally { _checkGate.Release(); }
                    }
                    catch (OperationCanceledException) when (ct.IsCancellationRequested) { return; }
                    catch (Exception ex)
                    {
                        // A transient file lock, IO or missing staged directory must not kill
                        // the only confirmation loop forever. Retry on the next bounded poll.
                        _logger.LogError("standalone native update confirmation failed; retrying on next poll", ex);
                    }
                }
            }
            catch (OperationCanceledException)
            {
                // normal shutdown
            }
        }

        /// <summary>Triggers an out-of-cycle check, e.g. when the gateway's `hello.ack` reports `status: "update_required"`.</summary>
        public void RequestImmediateCheck()
        {
            if (!_standaloneUpdatesEnabled)
            {
                _logger.LogWarning("gateway requested an update, but standalone updates are disabled; update via a signed Aleph Connector release.");
                return;
            }
            _ = RunCheckAsync(_cts?.Token ?? CancellationToken.None);
        }

        private async Task CheckLoopAsync(CancellationToken ct)
        {
            using var timer = new PeriodicTimer(_config.UpdateCheckInterval);
            while (!ct.IsCancellationRequested)
            {
                await RunCheckAsync(ct).ConfigureAwait(false);
                try
                {
                    if (!await timer.WaitForNextTickAsync(ct).ConfigureAwait(false)) return;
                }
                catch (OperationCanceledException)
                {
                    return;
                }
            }
        }

        private async Task RunCheckAsync(CancellationToken ct)
        {
            if (!await _checkGate.WaitAsync(0, ct).ConfigureAwait(false))
            {
                _logger.LogDebug("update check already in progress; skipping overlapping trigger");
                return;
            }
            try
            {
                UpdateCheckResult result;
                try
                {
                    result = await _coordinator.CheckAsync(_config.UpdateManifestUrl, ct).ConfigureAwait(false);
                }
                catch (Exception ex) when (!ct.IsCancellationRequested && IsChannelUnavailable(ex))
                {
                    // The standalone channel is emergency-only and dormant by default: install.ps1
                    // points every client at the manifest, but a signed release exists there only
                    // after an operator dispatches release-desktop.yml. "404 / host down" is the
                    // designed resting state, so it warns once per process rather than an Error
                    // every check interval on every machine. A fetched-but-malformed manifest is
                    // NOT here (it is a real published release that is broken) and falls through
                    // to the loud catch below.
                    WarnDormantChannelOnce(ex);
                    return;
                }
                _channelUnavailableReason = null;
                if (result.UpdateAvailable && result.Manifest is { } manifest)
                {
                    await HandleUpdateAsync(manifest, ct).ConfigureAwait(false);
                }
                else
                {
                    // No new release this tick, but an update may already be staged from an
                    // earlier run (e.g. the Bridge self-updated and restarted before AutoCAD
                    // closed, or the user confirmed but this process restarted before applying
                    // it) — resolve it opportunistically instead of waiting for a new manifest.
                    // Only actually applies anything if the user has confirmed it.
                    await ApplyConfirmedUpdateAsync(ct).ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                // Stopping the Bridge (self-update swap, Desktop reinstall, logoff) cancels the
                // check mid-fetch; that is a normal shutdown, not a fault to page anyone about.
                _logger.LogDebug("update check cancelled during shutdown");
            }
            catch (Exception ex)
            {
                _logger.LogError($"update check against \"{_config.UpdateManifestUrl}\" failed", ex);
            }
            finally
            {
                _checkGate.Release();
            }
        }

        private async Task HandleUpdateAsync(ReleaseManifest manifest, CancellationToken ct)
        {
            if (_stagedPluginVersion != manifest.Latest)
            {
                if (BundleLayout.RequiresElevation(_config.BundleRoot))
                {
                    // Staging writes Versions/<v>/ inside the bundle, and this unprivileged daemon
                    // cannot write Autodesk's implicitly-trusted folder. Declining before the
                    // download keeps the failure honest: Aleph Desktop (which performed the elevated
                    // install) has to carry the update, so a silent partial stage would look like an
                    // update that is stuck applying forever.
                    LogBundleNeedsElevationOnce();
                    return;
                }
                if (!SemVer.MeetsMinimum(BridgeConfig.BridgeVersion, manifest.MinimumBridgeVersion))
                {
                    _logger.LogWarning($"Standalone update requires Bridge {manifest.MinimumBridgeVersion}; installed version is {BridgeConfig.BridgeVersion}. Use a signed Desktop update first.");
                    return;
                }
                _logger.LogInformation($"update available: {manifest.Latest} (minimum bridge {manifest.MinimumBridgeVersion})");
                var stagedDir = await _coordinator.DownloadAndVerifyAsync(manifest, ct).ConfigureAwait(false);

                // Same ProgramData lock that Desktop's generated install.ps1 acquires.
                // Download/verification happens without it, but NO on-disk mutation can
                // interleave with Desktop swapping Bridge and Plugin directories.
                using (await NativeUpdateLock.AcquireAsync(ct).ConfigureAwait(false))
                {
                    await _coordinator.StagePluginAsync(stagedDir, _config.BundleRoot, manifest.Latest, ct).ConfigureAwait(false);
                    _stagedSelfUpdatePath = await _coordinator.StageSelfUpdateAsync(stagedDir, ct).ConfigureAwait(false);
                    _stagedPluginVersion = manifest.Latest;
                    _userConfirmed = false;
                    WritePendingActivationMarker(manifest.Latest, _stagedSelfUpdatePath, confirmed: false);
                }
                _logger.LogInformation($"staged version {manifest.Latest} into \"{_config.BundleRoot}\"; waiting for user confirmation before applying it");
            }

            if (_userConfirmed)
            {
                await ApplyConfirmedUpdateAsync(ct).ConfigureAwait(false);
            }
            else if (_stagedPluginVersion != null)
            {
                UpdateAvailable?.Invoke(_stagedPluginVersion);
            }
        }

        private bool _elevatedBundleLogged;
        private bool _channelUnavailableWarned;
        private string? _channelUnavailableReason;

        /// <summary>
        /// True when the standalone manifest simply could not be reached: not published yet
        /// (HTTP 404 / missing file), host down (HTTP 5xx), or transport failure (DNS, TLS,
        /// timeout). A manifest that came back but is malformed is NOT channel-unavailable —
        /// that is a real published release and must stay a loud per-check error.
        /// </summary>
        public static bool IsChannelUnavailable(Exception ex) =>
            ex is HttpRequestException or IOException or TimeoutException or TaskCanceledException;

        /// <summary>Short honest cause for the dormant-channel warning, so the same failure does
        /// not re-log and a *new* failure category does.</summary>
        public static string DescribeChannelUnavailable(Exception ex) => ex switch
        {
            HttpRequestException { StatusCode: System.Net.HttpStatusCode.NotFound } => "no signed release published yet (manifest 404)",
            HttpRequestException { StatusCode: { } status } => $"release host returned HTTP {(int)status}",
            HttpRequestException => "release host unreachable",
            FileNotFoundException => "no signed release published yet (manifest file not found)",
            DirectoryNotFoundException => "no signed release published yet (manifest path missing)",
            IOException => "release host unreachable",
            TimeoutException or TaskCanceledException => "release host timed out",
            _ => ex.Message,
        };

        private void WarnDormantChannelOnce(Exception ex)
        {
            var reason = DescribeChannelUnavailable(ex);
            if (_channelUnavailableWarned && _channelUnavailableReason == reason)
            {
                _logger.LogDebug($"standalone update channel still dormant: {reason}");
                return;
            }
            _channelUnavailableWarned = true;
            _channelUnavailableReason = reason;
            _logger.LogWarning(
                $"Standalone CAD update channel unavailable: {reason}. This is expected until an operator " +
                $"publishes a signed release via release-connector.yml; normal clients update through Aleph Connector.",
                ex);
        }

        private void LogBundleNeedsElevationOnce()
        {
            if (_elevatedBundleLogged) return;
            _elevatedBundleLogged = true;
            _logger.LogWarning($"the installed bundle at \"{_config.BundleRoot}\" is only writable with elevated rights, so this Bridge cannot stage plugin updates into it; update it through Aleph Connector instead");
        }

        /// <summary>
        /// Applies whatever is currently staged, but only if the user has actually confirmed it
        /// via <see cref="ConfirmUpdate"/> — does nothing (not even log) if nothing is staged or
        /// nothing is confirmed yet, so this is safe to call opportunistically from anywhere
        /// (a fresh check tick, a resumed marker on Start) without accidentally auto-installing
        /// an update the user never approved.
        /// </summary>
        private async Task ApplyConfirmedUpdateAsync(CancellationToken ct)
        {
            if (_stagedPluginVersion is null || !_userConfirmed) return;

            if (_stagedSelfUpdatePath is { } selfUpdatePath)
            {
                if (AnyCadProcessRunning())
                {
                    if (!_subscribedToExit)
                    {
                        _subscribedToExit = true;
                        _processMonitor.AllInstancesExited += OnAllInstancesExited;
                    }
                    _logger.LogInformation("CAD is still open; deferring standalone Bridge self-update to avoid dropping live drawing connections.");
                    return;
                }
                if (_subscribedToExit)
                {
                    _processMonitor.AllInstancesExited -= OnAllInstancesExited;
                    _subscribedToExit = false;
                }
                // Clear the self-update path (persisted too) before launching it: the swap
                // helper relaunches this exe, and the new process resumes from this same
                // marker — without clearing it first, every future restart would re-trigger
                // the self-update swap forever. The plugin's own version/confirmed state is
                // deliberately kept, in case its own activation is still pending (AutoCAD open).
                _stagedSelfUpdatePath = null;
                WritePendingActivationMarker(_stagedPluginVersion, null, confirmed: true);
                try
                {
                    LaunchSelfUpdateAndHandOff(selfUpdatePath);
                }
                catch
                {
                    // If powershell.exe could not even be launched, retain the staged Bridge
                    // path so the next bounded poll can retry. Otherwise a confirmed Plugin
                    // could activate while its matching Bridge executable stayed old.
                    _stagedSelfUpdatePath = selfUpdatePath;
                    WritePendingActivationMarker(_stagedPluginVersion, selfUpdatePath, confirmed: true);
                    throw;
                }
                return; // this process is about to be replaced
            }

            await TryActivateOrSubscribeAsync(ct).ConfigureAwait(false);
        }

        private bool AnyCadProcessRunning()
        {
            if (_processMonitor.AnyInstanceRunning) return true;
            // The AutoCAD monitor focuses on acad.exe and IPC. Headless hosts can still
            // have loaded native DLLs and must block Bridge replacement as well.
            foreach (string name in new[] { "acad", "acadcore", "accoreconsole" })
            {
                Process[] processes;
                try { processes = Process.GetProcessesByName(name); }
                catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException)
                {
                    _logger.LogWarning("Cannot enumerate active CAD processes; deferring native update.", ex);
                    return true;
                }
                try { if (processes.Length > 0) return true; }
                finally { foreach (var process in processes) process.Dispose(); }
            }
            return false;
        }

        private async Task TryActivateOrSubscribeAsync(CancellationToken ct)
        {
            if (_stagedPluginVersion is null) return;

            if (!AnyCadProcessRunning())
            {
                await ActivateStagedAsync(ct).ConfigureAwait(false);
                return;
            }

            if (_subscribedToExit) return;
            _subscribedToExit = true;
            _processMonitor.AllInstancesExited += OnAllInstancesExited;
            _logger.LogInformation($"AutoCAD is running; deferring activation of {_stagedPluginVersion} until it exits");
        }

        private void OnAllInstancesExited()
        {
            _ = Task.Run(async () =>
            {
                try
                {
                    await ApplyConfirmedUpdateAsync(CancellationToken.None).ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    _logger.LogError("failed to apply confirmed native update after AutoCAD exit", ex);
                }
            });
        }

        private async Task ActivateStagedAsync(CancellationToken ct)
        {
            var version = _stagedPluginVersion;
            if (version is null) return;

            using (await NativeUpdateLock.AcquireAsync(ct).ConfigureAwait(false))
            {
                // Version may have changed while waiting on Desktop's integration installer.
                // A previously confirmed standalone update must never downgrade the newly
                // installed, Tauri-signed Plugin.
                string installedPlugin = "";
                try
                {
                    using var json = JsonDocument.Parse(
                        File.ReadAllText(Path.Combine(_config.BundleRoot, "current.json")));
                    installedPlugin = json.RootElement.GetProperty("current").GetString() ?? "";
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or
                    System.Collections.Generic.KeyNotFoundException or InvalidOperationException)
                {
                    _logger.LogWarning("Cannot validate installed Plugin before native activation; keeping staged release inactive.", ex);
                    return;
                }
                if (!CanResumePendingVersion(version, BridgeConfig.BridgeVersion, installedPlugin))
                {
                    _logger.LogWarning($"Skipping stale standalone Plugin activation {version}; installed Plugin is {installedPlugin}.");
                    _stagedPluginVersion = null;
                    _userConfirmed = false;
                    _stagedSelfUpdatePath = null;
                    DeletePendingActivationMarker();
                    return;
                }
                await _coordinator.ActivateStagedPluginAsync(_config.BundleRoot, version, ct).ConfigureAwait(false);
            }
            _logger.LogInformation($"activated plugin version {version}");

            if (_subscribedToExit)
            {
                _processMonitor.AllInstancesExited -= OnAllInstancesExited;
                _subscribedToExit = false;
            }
            _stagedPluginVersion = null;
            _userConfirmed = false;
            _stagedSelfUpdatePath = null;
            DeletePendingActivationMarker();
        }

        // ---- self-update (replace-on-restart) ----------------------------------------------

        /// <summary>
        /// The running Bridge exe can't overwrite itself while executing, so a self-update
        /// hands off to a short-lived PowerShell helper: it waits for this process's PID to
        /// exit, copies the staged build over the install directory, and relaunches the exe.
        /// This process then raises <see cref="SelfUpdateStaged"/> so Program.cs can shut every
        /// component down cleanly before actually exiting.
        /// </summary>
        private void LaunchSelfUpdateAndHandOff(string stagedPath)
        {
            var currentExePath = Process.GetCurrentProcess().MainModule?.FileName;
            if (string.IsNullOrEmpty(currentExePath))
            {
                _logger.LogError("cannot resolve the running executable's path; skipping self-update swap.");
                return;
            }

            var installDir = Path.GetDirectoryName(currentExePath)!;
            var pid = Environment.ProcessId;
            var scriptPath = Path.Combine(Path.GetTempPath(), $"cadai-bridge-selfupdate-{pid}.ps1");

            // Paths may contain apostrophes (e.g. a custom Windows user profile), so every
            // value interpolated into a PowerShell single-quoted string must be escaped.
            static string QuotePs(string value) => value.Replace("'", "''");
            var staged = QuotePs(stagedPath);
            var installed = QuotePs(installDir);
            var exe = QuotePs(currentExePath);
            var marker = QuotePs(PendingActivationMarkerPath);
            var updateLock = QuotePs(NativeUpdateLock.DefaultPath);

            // The helper runs after this Bridge process exits. It independently acquires the
            // very same ProgramData lock as Desktop's installer, so a waiting helper cannot
            // overwrite a newer Desktop upgrade. It ALWAYS restarts the installed Bridge,
            // even when activation was declined (CAD opened, version regressed, timeout).
            var script =
                "$ErrorActionPreference = 'Stop'\n" +
                $"while (Get-Process -Id {pid} -ErrorAction SilentlyContinue) {{ Start-Sleep -Milliseconds 400 }}\n" +
                "Start-Sleep -Milliseconds 400\n" +
                "$lock = $null; $backup = $null; $swapStarted = $false; $safeToStart = $true\n" +
                "try {\n" +
                $"  $lockPath = '{updateLock}'\n" +
                "  $until = (Get-Date).AddMinutes(2)\n" +
                "  while ($null -eq $lock -and (Get-Date) -lt $until) {\n" +
                "    try { $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }\n" +
                "    catch [System.IO.IOException] { Start-Sleep -Milliseconds 200 }\n" +
                "  }\n" +
                "  if ($null -eq $lock) { throw 'Native update lock busy: refusing unsafe Bridge overwrite.' }\n" +
                "  if (@(Get-Process -Name 'acad', 'acadcore', 'accoreconsole' -ErrorAction SilentlyContinue).Count -gt 0) {\n" +
                "    throw 'CAD opened during Bridge handoff: refusing to interrupt a drawing session.'\n" +
                "  }\n" +
                $"  $stagedStamp = Join-Path '{staged}' 'component-version.json'\n" +
                $"  $installedStamp = Join-Path '{installed}' 'component-version.json'\n" +
                "  $stagedVersion = [Version]::Parse((Get-Content $stagedStamp -Raw | ConvertFrom-Json).version)\n" +
                "  if (Test-Path $installedStamp) {\n" +
                "    $installedVersion = [Version]::Parse((Get-Content $installedStamp -Raw | ConvertFrom-Json).version)\n" +
                "    if ($installedVersion -gt $stagedVersion) { throw 'Refusing to overwrite a newer Bridge with an older standalone package.' }\n" +
                "  }\n" +
                $"  $backup = '{installed}.previous.' + [Guid]::NewGuid().ToString('N')\n" +
                $"  Copy-Item -LiteralPath '{installed}' -Destination $backup -Recurse -ErrorAction Stop\n" +
                "  $swapStarted = $true; $safeToStart = $false\n" +
                $"  Copy-Item -Path (Join-Path '{staged}' '*') -Destination '{installed}' -Recurse -Force -ErrorAction Stop\n" +
                "  $safeToStart = $true; $swapStarted = $false\n" +
                "  Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue\n" +
                "  $backup = $null\n" +
                "} catch {\n" +
                $"  Remove-Item -LiteralPath '{marker}' -Force -ErrorAction SilentlyContinue\n" +
                "  if ($swapStarted -and $null -ne $backup -and (Test-Path -LiteralPath $backup)) {\n" +
                $"    Remove-Item -LiteralPath '{installed}' -Recurse -Force -ErrorAction Stop\n" +
                $"    Move-Item -LiteralPath $backup -Destination '{installed}' -ErrorAction Stop\n" +
                "    $backup = $null; $safeToStart = $true\n" +
                "  }\n" +
                "  # A failed self-update must not leave a confirmed Plugin marker that would\n" +
                "  # activate a newer Plugin against the old Bridge on the next restart.\n" +
                "  Write-Warning \"Standalone Bridge self-update was rejected: $($_.Exception.Message)\"\n" +
                "} finally {\n" +
                "  if ($null -ne $lock) { $lock.Dispose() }\n" +
                $"  if ($safeToStart) {{ Start-Process -FilePath '{exe}' }}\n" +
                "}\n";
            File.WriteAllText(scriptPath, script);

            _logger.LogInformation($"staged Bridge self-update at \"{stagedPath}\"; launching swap helper (pid {pid} awaited) and shutting down");

            var psi = new ProcessStartInfo
            {
                FileName = "powershell.exe",
                Arguments = $"-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File \"{scriptPath}\"",
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = Path.GetTempPath(),
            };
            using var helper = Process.Start(psi)
                ?? throw new InvalidOperationException("Unable to start Bridge self-update handoff process.");

            SelfUpdateStaged?.Invoke();
        }

        // ---- pending-activation marker (survives a Bridge self-update restart) --------------

        private PendingActivation? ReadPendingActivationMarker()
        {
            try
            {
                if (!File.Exists(PendingActivationMarkerPath)) return null;
                var marker = JsonSerializer.Deserialize<PendingActivation>(File.ReadAllText(PendingActivationMarkerPath), MarkerJsonOptions);
                return marker is { Version.Length: > 0 } ? marker : null;
            }
            catch (Exception ex)
            {
                _logger.LogWarning($"failed to read pending-activation marker at \"{PendingActivationMarkerPath}\"", ex);
                return null;
            }
        }

        /// <summary>
        /// A resumed Plugin must be newer than the installed Plugin and must not be older
        /// than the running Bridge. Equality with Bridge is legitimate after Bridge has
        /// already self-updated but Plugin activation was deferred while AutoCAD ran.
        /// </summary>
        public static bool CanResumePendingVersion(string pending, string bridge, string installedPlugin)
        {
            return Version.TryParse(pending, out var pendingVersion)
                && Version.TryParse(bridge, out var bridgeVersion)
                && Version.TryParse(installedPlugin, out var pluginVersion)
                && pendingVersion > pluginVersion
                && pendingVersion >= bridgeVersion;
        }

        private void ResumePendingActivationFromDisk()
        {
            var marker = ReadPendingActivationMarker();
            if (marker is null) return;
            string installedPlugin;
            try
            {
                using var current = JsonDocument.Parse(
                    File.ReadAllText(Path.Combine(_config.BundleRoot, "current.json")));
                installedPlugin = current.RootElement.GetProperty("current").GetString() ?? "";
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or
                System.Collections.Generic.KeyNotFoundException or InvalidOperationException)
            {
                _logger.LogWarning("Cannot validate the installed Plugin; refusing to activate an unverified staged update.", ex);
                return;
            }

            if (!CanResumePendingVersion(marker.Version, BridgeConfig.BridgeVersion, installedPlugin))
            {
                _logger.LogWarning($"Discarding obsolete staged update {marker.Version}: Bridge={BridgeConfig.BridgeVersion}, installed Plugin={installedPlugin}; update using signed Desktop instead.");
                DeletePendingActivationMarker();
                return;
            }
            _stagedPluginVersion = marker.Version;
            _userConfirmed = marker.Confirmed;
            _stagedSelfUpdatePath = marker.SelfUpdatePath;
            _logger.LogInformation($"resumed pending update to version {marker.Version} (confirmed={marker.Confirmed}) from \"{PendingActivationMarkerPath}\"");
        }

        private void WritePendingActivationMarker(string version, string? selfUpdatePath, bool confirmed)
        {
            Directory.CreateDirectory(_config.BundleRoot);
            File.WriteAllText(PendingActivationMarkerPath, JsonSerializer.Serialize(new PendingActivation(version, confirmed, selfUpdatePath), MarkerJsonOptions));
        }

        private void DeletePendingActivationMarker()
        {
            try { File.Delete(PendingActivationMarkerPath); } catch (IOException) { }
        }

        private static RSA LoadPublicKey(BridgeConfig config, IBridgeLogger logger)
        {
            if (!string.IsNullOrWhiteSpace(config.UpdaterPublicKeyPath))
            {
                return RsaPem.FromPemFile(config.UpdaterPublicKeyPath);
            }

            if (Environment.GetEnvironmentVariable("CADAI_ALLOW_DEV_UPDATER") == "1")
                logger.LogWarning("Unsafe development updater explicitly enabled with checked-in dev/test key; NEVER use this in production.");
            return RsaPem.FromPem(DevPublicKey.Pem);
        }

        public async ValueTask DisposeAsync()
        {
            _cts?.Cancel();
            foreach (var task in new[] { _loop, _confirmationLoop })
            {
                if (task is null) continue;
                try { await task.ConfigureAwait(false); } catch (OperationCanceledException) { }
            }
            if (_subscribedToExit)
            {
                _processMonitor.AllInstancesExited -= OnAllInstancesExited;
            }
            _cts?.Dispose();
            _checkGate.Dispose();
            _coordinator.Dispose();
        }

        private sealed record PendingActivation(string Version, bool Confirmed, string? SelfUpdatePath);
    }
}
