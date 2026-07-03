import fs from 'fs';
import path from 'path';
import { config } from '../config.js';

const recordingsDir = path.join(config.storageDir, 'recordings');
fs.mkdirSync(recordingsDir, { recursive: true });

export function getFilePath(filename: string): string {
  return path.join(recordingsDir, filename);
}

export async function saveFile(filename: string, data: Buffer): Promise<{ path: string; size: number }> {
  const filePath = getFilePath(filename);
  await fs.promises.writeFile(filePath, data);
  return { path: filename, size: data.length };
}

export async function deleteFile(filename: string): Promise<void> {
  await fs.promises.rm(getFilePath(filename), { force: true });
}
