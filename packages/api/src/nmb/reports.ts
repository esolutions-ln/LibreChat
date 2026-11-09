import { logger } from '@librechat/data-schemas';
import type { Request, RequestHandler, Response as ExpressResponse } from 'express';
import type { ScannerCall } from './scanner';
import type { ChartSpec } from './chart';
import type { NmbConfig } from './types';
import { resolveIdentity } from './identity';
import { validateChartSpec } from './chart';
import { isNmbMisconfigured } from './config';
import { ScannerError } from './scanner';

export type ReportFormat = 'xlsx' | 'pdf';

export interface ReportFile {
  bytes: Buffer;
  contentType: string;
}

/** Renders a validated chart spec to a file. The scanner draws the chart; nothing here sees document content. */
export interface ReportClient {
  render(format: ReportFormat, spec: ChartSpec): Promise<ReportFile>;
}

const MAX_REPORT_BYTES = 20 * 1024 * 1024;

export function createReportClient(call: ScannerCall): ReportClient {
  return {
    async render(format, spec) {
      const res = (await call('POST', `/report/${format}`, { json: spec, raw: true })) as Response;
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_REPORT_BYTES) {
        throw new ScannerError('bad_response');
      }
      return {
        bytes,
        contentType: res.headers.get('content-type') ?? 'application/octet-stream',
      };
    },
  };
}

export interface ReportAuditEntry {
  action: 'nmb_report.exported';
  actor: { type: 'user'; id: string; name: string };
  target: { type: 'nmb_report' };
  outcome: 'success' | 'failure';
  /** Format and counts only. Never titles, category or series names, or values. */
  metadata?: Record<string, string | number | boolean | null>;
}

export interface ReportHandlerDeps {
  config: NmbConfig;
  reports: ReportClient;
  recordAudit: (entry: ReportAuditEntry) => Promise<unknown>;
}

export interface ReportHandlers {
  gate: RequestHandler;
  exportReport: RequestHandler;
}

type SessionUser = { username?: string; email?: string };

const FORMATS = new Set<string>(['xlsx', 'pdf']);

export function createReportHandlers(deps: ReportHandlerDeps): ReportHandlers {
  const { config, reports } = deps;

  async function audit(entry: ReportAuditEntry): Promise<void> {
    logger.info('[nmb][report][audit]', {
      action: entry.action,
      actor: entry.actor.id,
      outcome: entry.outcome,
      ...entry.metadata,
    });
    try {
      await deps.recordAudit(entry);
    } catch (error) {
      logger.error('[nmb][report][audit] failed to write audit entry', {
        name: (error as Error)?.name,
      });
    }
  }

  const gate: RequestHandler = (_req, res, next) => {
    if (!config.enabled || !config.reports.enabled) {
      res.status(404).json({ message: 'Not found' });
      return;
    }
    if (isNmbMisconfigured(config)) {
      res.status(503).json({ type: 'nmb_unavailable', message: 'Gateway is not configured.' });
      return;
    }
    next();
  };

  const exportReport: RequestHandler = (async (req: Request, res: ExpressResponse) => {
    const identity = resolveIdentity(req, config);
    if (!identity) {
      res.status(401).json({ message: 'Authentication required' });
      return;
    }
    const body = (req.body ?? {}) as { format?: unknown; spec?: unknown };
    if (typeof body.format !== 'string' || !FORMATS.has(body.format)) {
      res.status(400).json({ type: 'nmb_report_invalid', message: 'Invalid format.' });
      return;
    }
    const format = body.format as ReportFormat;
    const parsed = validateChartSpec(body.spec);
    if (!parsed.ok) {
      res.status(400).json({
        type: 'nmb_report_invalid',
        message: 'The chart data is not valid.',
        reason: parsed.error,
      });
      return;
    }
    const spec = parsed.spec;
    const u = (req as Request & { user?: SessionUser }).user;
    const actor = {
      type: 'user' as const,
      id: identity.userId,
      name: u?.username ?? u?.email ?? identity.userId,
    };
    const counts = {
      format,
      chart: spec.type,
      origin: spec.origin ?? 'model',
      series: spec.series.length,
      points: spec.categories.length * spec.series.length,
    };
    try {
      const file = await reports.render(format, spec);
      await audit({
        action: 'nmb_report.exported',
        actor,
        target: { type: 'nmb_report' },
        outcome: 'success',
        metadata: { ...counts, bytes: file.bytes.length },
      });
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Type', file.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="report.${format}"`);
      res.setHeader('Content-Length', String(file.bytes.length));
      res.end(file.bytes);
    } catch (error) {
      await audit({
        action: 'nmb_report.exported',
        actor,
        target: { type: 'nmb_report' },
        outcome: 'failure',
        metadata: counts,
      });
      if (error instanceof ScannerError && error.kind === 'bad_request') {
        res
          .status(422)
          .json({ type: 'nmb_report_invalid', message: 'The chart data was rejected.' });
        return;
      }
      logger.error('[nmb][report] export failed', {
        kind: error instanceof ScannerError ? error.kind : (error as Error)?.name,
      });
      res
        .status(503)
        .json({ type: 'nmb_unavailable', message: 'Data-protection service unavailable.' });
    }
  }) as RequestHandler;

  return { gate, exportReport };
}
