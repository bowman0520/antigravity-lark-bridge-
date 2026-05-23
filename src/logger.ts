import * as fs from 'fs';
import * as path from 'path';
import { LOG_DIR } from './paths';

export interface LogDetails {
  [key: string]: any;
}

export class AuditLogger {
  private logDir: string;

  constructor() {
    this.logDir = LOG_DIR;
  }

  private getLogFilePath(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return path.join(this.logDir, `${year}-${month}-${day}.jsonl`);
  }

  private ensureLogDir() {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  public log(level: 'info' | 'warn' | 'error', event: string, details: LogDetails = {}) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      event,
      ...details,
    };

    const logLine = JSON.stringify(logEntry);

    // Print to console (stderr for clean stdout output of hooks)
    if (level === 'error') {
      console.error(logLine);
    } else {
      console.warn(logLine);
    }

    try {
      this.ensureLogDir();
      fs.appendFileSync(this.getLogFilePath(), logLine + '\n', 'utf8');
    } catch (err) {
      console.error(`Failed to write to audit log file: ${err}`);
    }
  }

  public info(event: string, details?: LogDetails) {
    this.log('info', event, details);
  }

  public warn(event: string, details?: LogDetails) {
    this.log('warn', event, details);
  }

  public error(event: string, message: string, details?: LogDetails) {
    this.log('error', event, { message, ...details });
  }
}

export const logger = new AuditLogger();
