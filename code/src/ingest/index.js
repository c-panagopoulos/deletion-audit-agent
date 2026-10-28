// Evidence Reader (ADR-003): turns every file listed in evidence_files.csv into resource observations.
// Each file is read independently; a file that fails is recorded with its error and the run continues
// (explicit, recoverable failure mode). Visual files (PNG/PDF) go through the vision extractor.
import fs from 'node:fs';
import path from 'node:path';
import { readCsv } from '../lib/csv.js';
import { dataset, CODE_DIR } from '../lib/paths.js';
import { readSql } from './sql.js';
import { readJson } from './json.js';
import { readLog } from './logs.js';
import { readText } from './text.js';
import { createVisualReader, readVisualUnavailable } from './visual.js';

const TEXT_READERS = {
  '.sql': readSql,
  '.json': readJson,
  '.log': readLog,
  '.txt': readText,
};

export function loadManifest() {
  return readCsv(dataset('evidence_files.csv')).map((r) => ({
    fileId: r.file_id,
    relPath: r.file_path,
    absPath: dataset(r.file_path),
    origin: r.origin,
    capturedAt: r.captured_at,
    ext: path.extname(r.file_path).toLowerCase(),
  }));
}

// Last ingest outcome per file, so `--retry-unreadable` knows which visual files to try again.
export const INGEST_REPORT = path.join(CODE_DIR, 'evaluation', 'ingest_report.json');

export function unreadableFileIds() {
  if (!fs.existsSync(INGEST_REPORT)) return [];
  return JSON.parse(fs.readFileSync(INGEST_REPORT, 'utf8')).files.filter((f) => f.status === 'unreadable').map((f) => f.fileId);
}

// `only`: restrict to these file ids (used by --retry-unreadable); the saved report is merged, not replaced.
// `extraFiles`: evaluation fixtures added on top of the dataset manifest (never used by main.js).
export async function ingestEvidence({ llm = null, onEvent = () => {}, only = null, saveReport = true, extraFiles = [] } = {}) {
  const files = [...loadManifest(), ...extraFiles].filter((f) => !only || only.includes(f.fileId));
  const observations = [];
  const report = [];
  const readVisual = llm ? createVisualReader(llm) : readVisualUnavailable;
  const readers = { ...TEXT_READERS, '.png': readVisual, '.pdf': readVisual };

  for (const file of files) {
    const reader = readers[file.ext];
    const entry = { fileId: file.fileId, path: file.relPath, status: 'ok', observations: 0, systems: [] };
    try {
      if (!reader) throw new Error(`no reader for ${file.ext}`);
      const { observations: obs, coverage, note, vision } = await reader(file);
      if (vision) entry.vision = vision;
      for (const o of obs) o.fileCapturedAt = file.capturedAt;
      observations.push(...obs);
      file.coverage = coverage;
      Object.assign(entry, { observations: obs.length, systems: coverage });
      if (note) Object.assign(entry, { status: 'partial', note });
    } catch (err) {
      if (err.dailyQuota) throw err; // quota stop is not "unreadable" (ADR-027)
      // A visual file the model could not read is `unreadable`: no observations, never cached, and
      // listed so it can be retried; the audit continues without it (ADR-013).
      const visual = file.ext === '.png' || file.ext === '.pdf';
      Object.assign(entry, { status: visual ? 'unreadable' : 'failed', error: err.message, attempts: err.attempts ?? 1 });
      file.coverage = [];
    }
    report.push(entry);
    onEvent({ type: 'file_ingested', ...entry });
  }
  if (saveReport) writeIngestReport(report);
  return { files, observations, report };
}

function writeIngestReport(report) {
  const prev = fs.existsSync(INGEST_REPORT) ? JSON.parse(fs.readFileSync(INGEST_REPORT, 'utf8')).files : [];
  const merged = new Map(prev.map((f) => [f.fileId, f]));
  for (const f of report) merged.set(f.fileId, f);
  const files = [...merged.values()].sort((a, b) => a.fileId.localeCompare(b.fileId, 'en', { numeric: true }));
  const counts = files.reduce((m, f) => ({ ...m, [f.status]: (m[f.status] ?? 0) + 1 }), {});
  const v = files.filter((f) => f.vision).map((f) => f.vision);
  const sum = (fn) => v.reduce((t, x) => t + fn(x), 0);
  const vision = {
    proposed: sum((x) => x.proposed), kept: sum((x) => x.kept), dropped: sum((x) => x.dropped.length),
    visionOnly: sum((x) => x.visionOnly.length), identityConfirmed: sum((x) => x.identity?.confirmed.length ?? 0),
    identityNearMatch: sum((x) => x.identity?.nearMatch.length ?? 0), identityUnconfirmed: sum((x) => x.identity?.unconfirmed.length ?? 0),
    majorityRejectedFiles: files.filter((f) => f.vision?.majorityRejected).map((f) => f.fileId),
  };
  fs.writeFileSync(INGEST_REPORT, JSON.stringify({ at: new Date().toISOString(), counts, vision, files }, null, 2));
}
