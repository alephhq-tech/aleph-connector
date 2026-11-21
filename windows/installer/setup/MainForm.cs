namespace AlephConnector.Setup;

public sealed class MainForm : Form
{
    private readonly TextBox _gatewayUrl = new() { Dock = DockStyle.Fill };
    private readonly TextBox _mcpUrl = new() { Dock = DockStyle.Fill };
    private readonly TextBox _deviceToken = new() { Dock = DockStyle.Fill };
    private readonly TextBox _log = new()
    {
        Dock = DockStyle.Fill,
        Multiline = true,
        ScrollBars = ScrollBars.Vertical,
        ReadOnly = true,
        Font = new Font("Consolas", 9f)
    };
    private readonly CheckedListBox _agents = new() { Dock = DockStyle.Fill, CheckOnClick = true };
    private readonly Button _refreshAgents = new() { Text = "Refresh agents", AutoSize = true };
    private readonly Button _installAutocad = new() { Text = "Install Bridge + AutoCAD plugin", AutoSize = true };
    private readonly Button _installMcp = new() { Text = "Install MCP into selected agents", AutoSize = true };
    private readonly Label _status = new() { AutoSize = true, Padding = new Padding(0, 8, 0, 0) };
    private List<DetectedAgent> _detected = [];

    public MainForm()
    {
        Text = "Aleph Connector Setup";
        Width = 720;
        Height = 640;
        MinimumSize = new Size(640, 520);
        StartPosition = FormStartPosition.CenterScreen;

        _gatewayUrl.Text = Environment.GetEnvironmentVariable("CADAI_GATEWAY_URL")
            ?? "wss://mcp.alephhq.tech/device";
        _mcpUrl.Text = Environment.GetEnvironmentVariable("ALEPH_MCP_URL")
            ?? "https://mcp.alephhq.tech/mcp";

        var root = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 6,
            Padding = new Padding(16)
        };
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 35));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 65));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));

        root.Controls.Add(BuildUrlsPanel(), 0, 0);
        root.Controls.Add(BuildAgentHeader(), 0, 1);
        root.Controls.Add(_agents, 0, 2);
        root.Controls.Add(BuildActions(), 0, 3);
        root.Controls.Add(_log, 0, 4);
        root.Controls.Add(_status, 0, 5);

        Controls.Add(root);

        _refreshAgents.Click += (_, _) => RefreshAgents();
        _installAutocad.Click += async (_, _) => await RunAutocadInstallAsync();
        _installMcp.Click += (_, _) => RunMcpInstall();

        RefreshAgents();
        AppendLog($"Package root: {AutocadInstaller.PackageRoot()}");
        AppendLog("Next: install AutoCAD integration, then select agents for MCP. Pair the device at portal.alephhq.tech.");
    }

    private Control BuildUrlsPanel()
    {
        var grid = new TableLayoutPanel { Dock = DockStyle.Top, AutoSize = true, ColumnCount = 2 };
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 140));
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        void Row(string label, Control control)
        {
            var r = grid.RowCount++;
            grid.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            grid.Controls.Add(new Label { Text = label, AutoSize = true, Anchor = AnchorStyles.Left }, 0, r);
            grid.Controls.Add(control, 1, r);
        }
        Row("Device Gateway WSS", _gatewayUrl);
        Row("MCP URL (HTTPS)", _mcpUrl);
        Row("Device token (optional)", _deviceToken);
        return grid;
    }

    private Control BuildAgentHeader()
    {
        var panel = new FlowLayoutPanel { Dock = DockStyle.Top, AutoSize = true };
        panel.Controls.Add(new Label
        {
            Text = "Detected agent clients (checked = install MCP)",
            AutoSize = true,
            Padding = new Padding(0, 8, 12, 0)
        });
        panel.Controls.Add(_refreshAgents);
        return panel;
    }

    private Control BuildActions()
    {
        var panel = new FlowLayoutPanel { Dock = DockStyle.Top, AutoSize = true, Padding = new Padding(0, 8, 0, 8) };
        panel.Controls.Add(_installAutocad);
        panel.Controls.Add(_installMcp);
        return panel;
    }

    private void RefreshAgents()
    {
        _agents.Items.Clear();
        _detected = AgentDetector.DetectAll().ToList();
        foreach (var agent in _detected)
        {
            var label = agent.Present
                ? $"{agent.DisplayName} — found ({agent.ConfigPath})"
                : $"{agent.DisplayName} — not detected";
            _agents.Items.Add(label, agent.Present);
        }
        _status.Text = $"Found {_detected.Count(a => a.Present)} agent(s) on this machine.";
    }

    private async Task RunAutocadInstallAsync()
    {
        _installAutocad.Enabled = false;
        _status.Text = "Installing Bridge + AutoCAD plugin…";
        try
        {
            var (ok, log) = await AutocadInstaller.InstallAsync(_gatewayUrl.Text.Trim(), _deviceToken.Text.Trim());
            AppendLog(log);
            _status.Text = ok
                ? "AutoCAD integration installed. Open AutoCAD, then pair the device in the portal."
                : "AutoCAD install failed — see log.";
        }
        catch (Exception ex)
        {
            AppendLog(ex.ToString());
            _status.Text = "AutoCAD install error.";
        }
        finally
        {
            _installAutocad.Enabled = true;
        }
    }

    private void RunMcpInstall()
    {
        var mcpUrl = _mcpUrl.Text.Trim();
        if (string.IsNullOrWhiteSpace(mcpUrl))
        {
            MessageBox.Show(this, "MCP URL is required.", Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }

        var written = 0;
        for (var i = 0; i < _agents.Items.Count; i++)
        {
            if (!_agents.GetItemChecked(i)) continue;
            var agent = _detected[i];
            try
            {
                var path = McpConfigWriter.Write(agent, mcpUrl);
                AppendLog($"MCP → {agent.DisplayName}: {path}");
                written++;
            }
            catch (Exception ex)
            {
                AppendLog($"MCP → {agent.DisplayName} FAILED: {ex.Message}");
            }
        }

        _status.Text = written == 0
            ? "No agents selected (or all writes failed)."
            : $"Wrote MCP config for {written} agent(s). Complete OAuth when the client connects.";
    }

    private void AppendLog(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return;
        _log.AppendText(text.TrimEnd() + Environment.NewLine + Environment.NewLine);
    }
}
