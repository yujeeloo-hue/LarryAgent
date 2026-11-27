
const USAGE = `jellybot-agentd — headless JellyBot device node

Usage:
  agentd run                    Start the agent runtime (used by systemd)
  agentd setup                  Interactive first-run configuration
  agentd set-device-name <name> Update the Relay display name without re-running setup
  agentd update <url|file>      Install a new release and switch
         [--sha256 <hex>] [--install-dir <dir>] [--force]
  agentd rollback               Switch back to the previous release
  agentd install-updater        One-time: root updater + reboot units.
                                --with-reboot is accepted and ignored
                                (reboot is always included). Requires root.
  agentd process-update-queue   Root updater oneshot (systemd unit target)
  agentd process-reboot-queue   Root reboot oneshot (systemd unit target)
  agentd version                Print the installed version
`;

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "run": {
      process.env.JELLYBOT_HEADLESS = process.env.JELLYBOT_HEADLESS || "1";
      const { runAgentd } = await import("./runMain.js");
      await runAgentd();
      return 0;
    }
    case "setup": {
      const { runAgentdSetup } = await import("./setup.js");
      return await runAgentdSetup();
    }
    case "set-device-name": {
      const { runAgentdSetDeviceName } = await import("./setDeviceName.js");
      return await runAgentdSetDeviceName(rest);
    }
    case "update": {
      const { runAgentdUpdate } = await import("./update.js");
      return await runAgentdUpdate(rest);
    }
    case "rollback": {
      const { runAgentdRollback } = await import("./update.js");
      return await runAgentdRollback();
    }
    case "install-updater": {
      const { runAgentdInstallUpdater } = await import("./installUpdater.js");
      return await runAgentdInstallUpdater(rest);
    }
    case "process-update-queue": {
      const { runUpdaterWorker } = await import("./updaterWorker.js");
      return await runUpdaterWorker();
    }
    case "process-reboot-queue": {
      const { runRebootWorker } = await import("./rebootWorker.js");
      return await runRebootWorker();
    }
    case "version":
    case "--version":
    case "-v": {
      const { resolveAgentdVersion } = await import("./config.js");
      process.stdout.write(`jellybot-agentd ${resolveAgentdVersion()}\n`);
      return 0;
    }
    case undefined:
    case "help":
    case "--help":
    case "-h": {
      process.stdout.write(USAGE);
      return 0;
    }
    default: {
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
      return 1;
    }
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const detail =
      error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`[agentd] fatal: ${detail}\n`);
    process.exitCode = 1;
  },
);
