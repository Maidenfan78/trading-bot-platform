import { exec } from 'child_process';
import { promisify } from 'util';
import { ServiceStatus } from '../types';

const execAsync = promisify(exec);

/**
 * Systemctl Service
 *
 * Manages systemd services for bots.
 */
export class SystemctlService {
  /**
   * Get status of a systemd service
   */
  async getStatus(serviceName: string): Promise<ServiceStatus> {
    try {
      const { stdout } = await execAsync(
        `systemctl show ${serviceName} --property=ActiveState,MainPID,ActiveEnterTimestamp --no-pager`
      );

      const props = this.parseSystemctlOutput(stdout);
      const running = props.ActiveState === 'active';
      const pid = parseInt(props.MainPID) || null;
      const uptime = this.calculateUptime(props.ActiveEnterTimestamp);

      return {
        running,
        pid,
        uptime,
        activeState: props.ActiveState || 'unknown',
      };
    } catch (error) {
      console.error(`Failed to get status for ${serviceName}:`, error);
      return {
        running: false,
        pid: null,
        uptime: 0,
        activeState: 'failed',
      };
    }
  }

  /**
   * Start a systemd service
   */
  async start(serviceName: string): Promise<void> {
    console.log(`Starting service: ${serviceName}`);
    await execAsync(`sudo systemctl start ${serviceName}`);
    console.log(`Service started: ${serviceName}`);
  }

  /**
   * Stop a systemd service
   */
  async stop(serviceName: string): Promise<void> {
    console.log(`Stopping service: ${serviceName}`);
    await execAsync(`sudo systemctl stop ${serviceName}`);
    console.log(`Service stopped: ${serviceName}`);
  }

  /**
   * Restart a systemd service
   */
  async restart(serviceName: string): Promise<void> {
    console.log(`Restarting service: ${serviceName}`);
    await execAsync(`sudo systemctl restart ${serviceName}`);
    console.log(`Service restarted: ${serviceName}`);
  }

  /**
   * Enable a systemd service
   */
  async enable(serviceName: string): Promise<void> {
    console.log(`Enabling service: ${serviceName}`);
    await execAsync(`sudo systemctl enable ${serviceName}`);
    console.log(`Service enabled: ${serviceName}`);
  }

  /**
   * Disable a systemd service
   */
  async disable(serviceName: string): Promise<void> {
    console.log(`Disabling service: ${serviceName}`);
    await execAsync(`sudo systemctl disable ${serviceName}`);
    console.log(`Service disabled: ${serviceName}`);
  }

  /**
   * Parse systemctl show output
   */
  private parseSystemctlOutput(output: string): Record<string, string> {
    const lines = output.trim().split('\n');
    const props: Record<string, string> = {};

    for (const line of lines) {
      const [key, value] = line.split('=');
      if (key && value !== undefined) {
        props[key] = value;
      }
    }

    return props;
  }

  /**
   * Calculate uptime from timestamp
   */
  private calculateUptime(timestamp: string): number {
    if (!timestamp || timestamp === '0' || timestamp === '') {
      return 0;
    }

    try {
      // systemctl returns timestamps like "Sat 2026-01-10 11:20:17 AEDT"
      // Node.js Date() can't parse timezone abbreviations, so we need to remove them
      const cleanTimestamp = timestamp.replace(/\s+[A-Z]{3,5}$/, '').trim();
      const start = new Date(cleanTimestamp).getTime();
      if (isNaN(start)) {
        return 0;
      }
      // Return uptime in seconds (not milliseconds)
      return Math.floor(Math.max(0, Date.now() - start) / 1000);
    } catch {
      return 0;
    }
  }

  /**
   * Check if a service exists
   */
  async serviceExists(serviceName: string): Promise<boolean> {
    try {
      await execAsync(`systemctl cat ${serviceName}`);
      return true;
    } catch {
      return false;
    }
  }
}
