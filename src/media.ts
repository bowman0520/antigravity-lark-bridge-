import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

export interface ImagePrepareOptions {
  enabled: boolean;
  maxWidthPx: number;
  jpegQuality: number;
  maxBytes: number;
}

export interface PreparedImage {
  path: string;
  originalPath: string;
  originalBytes: number;
  finalBytes: number;
  compressed: boolean;
}

export function prepareImageForAgent(filePath: string, options: ImagePrepareOptions): PreparedImage {
  const originalBytes = fs.statSync(filePath).size;
  if (!options.enabled) {
    return {
      path: filePath,
      originalPath: filePath,
      originalBytes,
      finalBytes: originalBytes,
      compressed: false,
    };
  }

  const attempts = [
    { width: options.maxWidthPx, quality: options.jpegQuality },
    { width: Math.min(options.maxWidthPx, 1200), quality: Math.min(options.jpegQuality, 78) },
    { width: Math.min(options.maxWidthPx, 900), quality: Math.min(options.jpegQuality, 72) },
  ];

  let bestPath = filePath;
  let bestBytes = originalBytes;

  for (const attempt of attempts) {
    const outPath = buildOutputPath(filePath, attempt.width, attempt.quality);
    try {
      execFileSync(
        '/usr/bin/sips',
        [
          '-s',
          'format',
          'jpeg',
          '-s',
          'formatOptions',
          String(attempt.quality),
          '-Z',
          String(attempt.width),
          filePath,
          '--out',
          outPath,
        ],
        { stdio: 'ignore', timeout: 15000 }
      );

      const outBytes = fs.statSync(outPath).size;
      if (outBytes < bestBytes) {
        bestPath = outPath;
        bestBytes = outBytes;
      }
      if (outBytes <= options.maxBytes) break;
    } catch (err) {
      // sips is macOS-only. If it fails, keep the original image.
    }
  }

  return {
    path: bestPath,
    originalPath: filePath,
    originalBytes,
    finalBytes: bestBytes,
    compressed: bestPath !== filePath,
  };
}

function buildOutputPath(filePath: string, width: number, quality: number): string {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath, path.extname(filePath));
  return path.join(dir, `${base}.agent-${width}w-q${quality}.jpg`);
}
