#!/usr/bin/env node
/**
 * OmniRoute Keep-Alive + Process Supervisor
 * ==========================================
 *
 * Render.com free tier, 15 dakikalık inaktivitede instance'ı uyutur ("sleep mode").
 * Bu script üç modda çalışarak uyku modunu engeller ve servisi ayakta tutar:
 *
 *   --supervise  : OmniRoute'u child process olarak başlatır + düzenli self-ping yapar.
 *                  (Render web service başlatma komutu için önerilen mod)
 *   --once       : Tek seferlik ping atar ve çıkar. (Render cron job / CI için)
 *   (varsayılan) : Sadece ping loop'u çalıştırır. (Lokal PC / VPS / alternatif)
 *
 * Ortam değişkenleri:
 *   KEEP_ALIVE_URL        Ping atılacak base URL      (örn. https://omniroute.onrender.com)
 *   KEEP_ALIVE_PATH       Health path                 (varsayılan: /api/health/ping)
 *   KEEP_ALIVE_INTERVAL   Ping aralığı (saniye)       (varsayılan: 300 = 5 dk)
 *   KEEP_ALIVE_TIMEOUT_MS Ping zaman aşımı (ms)       (varsayılan: 10000)
 *   START_COMMAND         --supervise'da başlatılacak komut
 *                         (varsayılan: node dev/run-standalone.mjs)
 *   MAX_RESTARTS          Crash'te maksimum yeniden başlatma (varsayılan: 5)
 *
 * Örnek kullanım:
 *   # Render web service (supervise + self-ping)
 *   node keep-alive.mjs --supervise
 *
 *   # Render cron job (her 5 dk'da bir tek ping)
 *   node keep-alive.mjs --once
 *
 *   # Lokalde çalışan OmniRoute'a ping (sunucu zaten açıksa)
 *   node scripts/dev/keep-alive.mjs --url=http://127.0.0.1:20128
 */

import { spawn } from "node:child_process";

// ── Konfigürasyon ────────────────────────────────────────────────────────────
const DEFAULT_INTERVAL_SEC = Number(process.env.KEEP_ALIVE_INTERVAL || 300);
const PING_TIMEOUT_MS = Number(process.env.KEEP_ALIVE_TIMEOUT_MS || 10_000);
const MAX_RESTARTS = Number(process.env.MAX_RESTARTS || 5);
const FIRST_PING_DELAY_MS = 30_000; // supervise modunda OmniRoute boot süresi
const RESTART_DELAY_MS = 5_000;

const args = process.argv.slice(2);
const mode = args.includes("--supervise")
  ? "supervise"
  : args.includes("--once")
    ? "once"
    : "loop";

const urlArg = args.find((a) => a.startsWith("--url="));
const port = process.env.PORT || 20128;
const targetBase =
  urlArg?.slice(6) ||
  process.env.KEEP_ALIVE_URL ||
  `http://127.0.0.1:${port}`;
const healthPath = process.env.KEEP_ALIVE_PATH || "/api/health/ping";
const target = `${targetBase.replace(/\/+$/, "")}${healthPath}`;

// ── Yardımcılar ──────────────────────────────────────────────────────────────
function log(...parts) {
  console.log(`[keep-alive] ${new Date().toISOString()}`, ...parts);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Ping ─────────────────────────────────────────────────────────────────────
async function ping() {
  const startedAt = Date.now();
  try {
    const res = await fetch(target, {
      method: "GET",
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    const ms = Date.now() - startedAt;
    // HTTP 2xx/3xx/5xx: server canlı. 503 dahil — istek uyku modunu engeller.
    log(`PING ${res.status} ${res.statusText} (${ms}ms) → ${target}`);
    return { ok: true, status: res.status };
  } catch (err) {
    const ms = Date.now() - startedAt;
    log(`PING HATA (${ms}ms) ${err instanceof Error ? err.message : String(err)} → ${target}`);
    return { ok: false, status: 0 };
  }
}

async function runLoop() {
  log(`Keep-alive döngüsü başladı → ${target} (aralık: ${DEFAULT_INTERVAL_SEC}s)`);
  // İlk ping hemen değil; OmniRoute'un ayakta olması beklenir.
  await sleep(FIRST_PING_DELAY_MS);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await ping();
    await sleep(DEFAULT_INTERVAL_SEC * 1000);
  }
}

// ── Supervisor (--supervise) ─────────────────────────────────────────────────
let child = null;
let restartCount = 0;
let shuttingDown = false;

function startOmniroute() {
  if (shuttingDown) return;
  const startCmd = process.env.START_COMMAND || "node dev/run-standalone.mjs";
  const [cmd, ...cmdArgs] = startCmd.split(/\s+/).filter(Boolean);
  log(`OmniRoute başlatılıyor: ${startCmd} (cwd: ${process.cwd()})`);
  child = spawn(cmd, cmdArgs, {
    stdio: "inherit",
    env: process.env,
    cwd: process.cwd(),
  });
  child.on("error", (err) => {
    log(`OmniRoute spawn hatası: ${err.message}`);
  });
  child.on("exit", (code, signal) => {
    log(`OmniRoute çıktı (code=${code}, signal=${signal})`);
    child = null;
    if (shuttingDown) return;
    if (restartCount < MAX_RESTARTS) {
      restartCount += 1;
      log(`[supervise] ${MAX_RESTARTS - restartCount} yeniden başlatma hakkı kaldı. ${RESTART_DELAY_MS / 1000}s sonra tekrar deneniyor...`);
      setTimeout(startOmniroute, RESTART_DELAY_MS);
    } else {
      log(`[supervise] Maksimum yeniden başlatma denemesi aşıldı (${MAX_RESTARTS}). Çıkılıyor — Render instance'ı yeniden başlatacak.`);
      process.exit(1);
    }
  });
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    shuttingDown = true;
    log(`[supervise] ${sig} alındı — OmniRoute kapatılıyor...`);
    if (child) {
      try {
        child.kill(sig);
      } catch {
        /* zaten kapalı */
      }
    }
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

// ── Ana akış ─────────────────────────────────────────────────────────────────
if (mode === "supervise") {
  startOmniroute();
  runLoop(); // ping döngüsü burada da başlar; spawn hatası olsa bile devam eder
} else if (mode === "once") {
  const result = await ping();
  process.exit(result.ok ? 0 : 1);
} else {
  runLoop();
}
