using System;
using System.IO;

namespace CadAi.Bridge.Diagnostics
{
    /// <summary>Log severity, ordered low-to-high like every other structured logging library.</summary>
    public enum BridgeLogLevel
    {
        Debug,
        Information,
        Warning,
        Error,
        Critical,
    }

    /// <summary>
    /// Minimal logging seam so every component logs through an interface instead of
    /// <see cref="Console"/> directly (testable, swappable). Deliberately not
    /// Microsoft.Extensions.Logging's <c>ILogger&lt;T&gt;</c> — the Bridge has no other reason to
    /// take that package dependency, and this two-method interface covers everything a
    /// console+rolling-file sink needs. See README.md "Logging" for the tradeoff.
    /// </summary>
    public interface IBridgeLogger
    {
        void Log(BridgeLogLevel level, string message, Exception? exception = null);
    }

    public static class BridgeLoggerExtensions
    {
        public static void LogDebug(this IBridgeLogger logger, string message) =>
            logger.Log(BridgeLogLevel.Debug, message);

        public static void LogInformation(this IBridgeLogger logger, string message) =>
            logger.Log(BridgeLogLevel.Information, message);

        public static void LogWarning(this IBridgeLogger logger, string message, Exception? exception = null) =>
            logger.Log(BridgeLogLevel.Warning, message, exception);

        public static void LogError(this IBridgeLogger logger, string message, Exception? exception = null) =>
            logger.Log(BridgeLogLevel.Error, message, exception);

        public static void LogCritical(this IBridgeLogger logger, string message, Exception? exception = null) =>
            logger.Log(BridgeLogLevel.Critical, message, exception);
    }

    /// <summary>
    /// Creates <see cref="IBridgeLogger"/> instances that mirror every line to stderr (stdout is
    /// reserved for any future structured status output) and to a daily-rolling file under
    /// %ProgramData%\CadAI\bridge\logs. The Bridge runs unattended as a background
    /// process/service, so "one plain-text file per day" is enough to diagnose field issues
    /// without pulling in Serilog/NLog for a process this small.
    /// </summary>
    public sealed class BridgeLoggerFactory
    {
        private readonly string _logDirectory;
        private readonly BridgeLogLevel _minimumLevel;
        private readonly object _writeLock = new();

        public event Action<string>? LogEmitted;
        public string LogDirectory => _logDirectory;

        public BridgeLoggerFactory(string logDirectory, BridgeLogLevel minimumLevel = BridgeLogLevel.Information)
        {
            _logDirectory = logDirectory;
            _minimumLevel = minimumLevel;
            Directory.CreateDirectory(_logDirectory);
        }

        public IBridgeLogger CreateLogger(string category) => new Logger(category, this);

        private void Write(BridgeLogLevel level, string category, string message, Exception? exception)
        {
            if (level < _minimumLevel) return;

            var line = $"{DateTimeOffset.UtcNow:O} [{level,-11}] {category}: {message}";
            if (exception != null) line += Environment.NewLine + exception;

            var path = Path.Combine(_logDirectory, $"bridge-{DateTime.UtcNow:yyyy-MM-dd}.log");
            lock (_writeLock)
            {
                Console.Error.WriteLine(line);
                File.AppendAllText(path, line + Environment.NewLine);
            }
            LogEmitted?.Invoke(line);
        }

        private sealed class Logger : IBridgeLogger
        {
            private readonly string _category;
            private readonly BridgeLoggerFactory _factory;

            public Logger(string category, BridgeLoggerFactory factory)
            {
                _category = category;
                _factory = factory;
            }

            public void Log(BridgeLogLevel level, string message, Exception? exception = null) =>
                _factory.Write(level, _category, message, exception);
        }
    }
}
