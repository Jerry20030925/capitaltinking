import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The trade ledger. On an always-on host, set LEDGER_DIR to a persistent volume
 * (e.g. /data) so it survives restarts; otherwise it lives at the repo root.
 */
export const AUDIT_FILE = process.env.LEDGER_DIR
  ? join(process.env.LEDGER_DIR, "trades.log.jsonl")
  : fileURLToPath(new URL("../trades.log.jsonl", import.meta.url));

const ts = () => new Date().toISOString();

export const log = {
  info: (...a: unknown[]) => console.log(`\x1b[36m[${ts()}]\x1b[0m`, ...a),
  warn: (...a: unknown[]) => console.warn(`\x1b[33m[${ts()}] WARN\x1b[0m`, ...a),
  error: (...a: unknown[]) => console.error(`\x1b[31m[${ts()}] ERROR\x1b[0m`, ...a),
  ok: (...a: unknown[]) => console.log(`\x1b[32m[${ts()}]\x1b[0m`, ...a),
};

/** Append-only audit trail of every decision and action. */
export async function audit(event: Record<string, unknown>): Promise<void> {
  const line = JSON.stringify({ at: ts(), ...event }) + "\n";
  try {
    await appendFile(AUDIT_FILE, line);
  } catch (e) {
    log.error("failed to write audit log", e);
  }
}
