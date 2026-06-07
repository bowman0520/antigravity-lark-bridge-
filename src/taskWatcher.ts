import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from './logger';
import { LarkGateway } from './lark';

const WATCH_DIR = path.join(os.homedir(), '.agents', '.bridge_tasks_watch');

export function startTaskWatcher(gateway: LarkGateway) {
  if (!fs.existsSync(WATCH_DIR)) {
    fs.mkdirSync(WATCH_DIR, { recursive: true });
  }

  logger.info('watchdog.started', { dir: WATCH_DIR });

  fs.watch(WATCH_DIR, (eventType, filename) => {
    if (!filename) return;
    
    // We expect files in the format: <url_encoded_scope>.done
    // Example: p2p%3Aoc_74804770ffa6659df1234379be79783c.done
    if (eventType === 'rename' && filename.endsWith('.done')) {
      const filePath = path.join(WATCH_DIR, filename);
      
      // If file exists, it was created (not deleted)
      if (fs.existsSync(filePath)) {
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          const scopeEncoded = filename.replace('.done', '');
          const scope = decodeURIComponent(scopeEncoded);
          
          logger.info('watchdog.task_completed', { scope, filename });
          
          // Inject the system message to wake up the agent
          gateway.injectSystemMessage(scope, content || 'Background task execution completed. Please check the results and continue your reasoning.');
          
          // Clean up the trigger file
          fs.unlinkSync(filePath);
        } catch (err: any) {
          logger.error('watchdog.read_failed', err.message, { filename });
        }
      }
    }
  });
}
