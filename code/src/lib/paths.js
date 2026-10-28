// All paths resolve from the repository root so the tool runs the same from any cwd or OS.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CODE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REPO_ROOT = path.resolve(CODE_DIR, '..');
export const DATASET_DIR = path.join(REPO_ROOT, 'dataset');
export const CACHE_DIR = path.join(CODE_DIR, '.cache');

export const dataset = (...parts) => path.join(DATASET_DIR, ...parts);
