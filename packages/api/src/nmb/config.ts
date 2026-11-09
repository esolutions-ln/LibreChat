import type { NmbConfig } from './types';

const TRUE = new Set(['1', 'true', 'yes', 'on']);
const isTrue = (v: string | undefined): boolean => v != null && TRUE.has(v.trim().toLowerCase());

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseRoleDepartments(raw: string | undefined): Record<string, string> {
  if (!raw) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [role, dept] of Object.entries(parsed)) {
      if (typeof dept === 'string' && dept.trim()) {
        out[role] = dept.trim();
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Reads the gateway configuration from the environment. Pure; takes `env` so tests need no globals. */
export function loadNmbConfig(env: NodeJS.ProcessEnv = process.env): NmbConfig {
  const timeout = Number.parseInt(env.NMB_SCANNER_TIMEOUT_MS ?? '', 10);
  return {
    enabled: isTrue(env.NMB_GATEWAY_ENABLED),
    scannerUrl: (env.NMB_SCANNER_URL ?? '').trim().replace(/\/+$/, ''),
    serviceKey: env.NMB_SERVICE_KEY ?? '',
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 20000,
    roleDepartments: parseRoleDepartments(env.NMB_ROLE_DEPARTMENTS),
    defaultDepartment: env.NMB_DEFAULT_DEPARTMENT?.trim() || undefined,
    maskNote: env.NMB_MASK_NOTE == null ? true : isTrue(env.NMB_MASK_NOTE),
    regexBlocklist: isTrue(env.NMB_SCANNER_REGEX_BLOCKLIST),
    analysis: {
      enabled: isTrue(env.NMB_ANALYSIS_ENABLED),
      maxUploadBytes: positiveInt(env.NMB_ANALYSIS_MAX_UPLOAD_BYTES, 26_214_400),
      maxCodeChars: positiveInt(env.NMB_ANALYSIS_MAX_CODE_CHARS, 50_000),
      executeTimeoutMs: positiveInt(env.NMB_ANALYSIS_EXECUTE_TIMEOUT_MS, 120_000),
      executeRateMax: positiveInt(env.NMB_ANALYSIS_EXECUTE_MAX, 20),
      executeRateWindowMinutes: positiveInt(env.NMB_ANALYSIS_EXECUTE_WINDOW_MINUTES, 15),
      maxConcurrentRuns: positiveInt(env.NMB_ANALYSIS_MAX_CONCURRENT_RUNS, 2),
    },
  };
}

/** True when the gateway is on but cannot reach a scanner; every request must then be refused. */
export function isNmbMisconfigured(config: NmbConfig): boolean {
  return config.enabled && (!config.scannerUrl || !config.serviceKey);
}
