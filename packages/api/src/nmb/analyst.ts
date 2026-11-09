import { createHash } from 'node:crypto';
import { logger } from '@librechat/data-schemas';
import type { Request, RequestHandler, Response } from 'express';
import type { AnalysisTarget, NmbConfig } from './types';
import type { AnalysisClient } from './analysis';
import { isNmbMisconfigured } from './config';
import { resolveIdentity } from './identity';
import { ScannerError } from './scanner';

export type AnalysisAuditAction =
  | 'nmb_analysis.dataset_uploaded'
  | 'nmb_analysis.synthesized'
  | 'nmb_analysis.executed'
  | 'nmb_analysis.dataset_deleted';

export interface AnalysisAuditEntry {
  action: AnalysisAuditAction;
  actor: { type: 'user'; id: string; name: string };
  target: { type: 'nmb_dataset' | 'nmb_run'; id?: string };
  outcome: 'success' | 'failure';
  /** Counts, ids and flags only. Never code, column names or values. */
  metadata?: Record<string, string | number | boolean | null>;
}

export interface AnalysisHandlerDeps {
  config: NmbConfig;
  analysis: AnalysisClient;
  recordAudit: (entry: AnalysisAuditEntry) => Promise<unknown>;
}

export interface AnalysisUpload {
  buffer: Buffer;
  originalname: string;
  size: number;
}

export interface AnalysisHandlers {
  gate: RequestHandler;
  upload: RequestHandler;
  list: RequestHandler;
  get: RequestHandler;
  remove: RequestHandler;
  synthesize: RequestHandler;
  synthetic: RequestHandler;
  execute: RequestHandler;
  getRun: RequestHandler;
  getRunFile: RequestHandler;
  limits: RequestHandler;
}

export const DATASET_ID_RE = /^ds_[0-9a-f]{12}$/;
export const RUN_ID_RE = /^run_[0-9a-f]{12}$/;
const FILE_NAME_RE = /^[\w][\w .-]{0,119}$/;
const MAX_COLUMNS = 500;
const MAX_COLUMN_NAME = 200;
const MAX_ROWS = 10_000;

type SessionUser = { id?: string; _id?: { toString(): string }; username?: string; email?: string };

const isCsv = (name: string): boolean => name.toLowerCase().endsWith('.csv');
const hash = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);

export function createAnalysisHandlers(deps: AnalysisHandlerDeps): AnalysisHandlers {
  const { config, analysis } = deps;

  const actorOf = (req: Request, userId: string): AnalysisAuditEntry['actor'] => {
    const u = (req as Request & { user?: SessionUser }).user;
    return { type: 'user', id: userId, name: u?.username ?? u?.email ?? userId };
  };

  async function audit(entry: AnalysisAuditEntry): Promise<void> {
    logger.info('[nmb][analysis][audit]', {
      action: entry.action,
      actor: entry.actor.id,
      target: entry.target.id ?? entry.target.type,
      outcome: entry.outcome,
      ...entry.metadata,
    });
    try {
      await deps.recordAudit(entry);
    } catch (error) {
      logger.error('[nmb][analysis][audit] failed to write audit entry', {
        action: entry.action,
        name: (error as Error)?.name,
      });
    }
  }

  function fail(res: Response, error: unknown): void {
    if (error instanceof ScannerError) {
      if (error.kind === 'not_found') {
        res.status(404).json({ message: 'Not found' });
        return;
      }
      if (error.kind === 'conflict') {
        res.status(409).json({
          type: 'nmb_analysis_not_ready',
          message: 'Generate a synthetic twin for this dataset first.',
        });
        return;
      }
      if (error.kind === 'bad_request') {
        res.status(422).json({
          type: 'nmb_analysis_invalid',
          message: 'The request could not be processed.',
        });
        return;
      }
    }
    logger.error('[nmb][analysis] request failed', {
      kind: error instanceof ScannerError ? error.kind : (error as Error)?.name,
    });
    res
      .status(503)
      .json({ type: 'nmb_unavailable', message: 'Data-protection service unavailable.' });
  }

  /** Resolves the session user once per call; answers 401/400 itself when the call cannot proceed. */
  function identify(req: Request, res: Response, idRe?: RegExp, id?: string): string | null {
    const identity = resolveIdentity(req, config);
    if (!identity) {
      res.status(401).json({ message: 'Authentication required' });
      return null;
    }
    if (idRe && !(typeof id === 'string' && idRe.test(id))) {
      res.status(400).json({ message: 'Invalid id' });
      return null;
    }
    return identity.userId;
  }

  const gate: RequestHandler = (_req, res, next) => {
    if (!config.enabled || !config.analysis.enabled) {
      res.status(404).json({ message: 'Not found' });
      return;
    }
    if (isNmbMisconfigured(config)) {
      res.status(503).json({ type: 'nmb_unavailable', message: 'Gateway is not configured.' });
      return;
    }
    next();
  };

  const noStore = (res: Response): void => {
    res.setHeader('Cache-Control', 'no-store');
  };

  return {
    gate,

    /** POST /datasets (multipart `file`) */
    upload: (async (req, res) => {
      const user = identify(req, res);
      if (!user) {
        return;
      }
      const file = (req as Request & { file?: AnalysisUpload }).file;
      if (!file || !isCsv(file.originalname)) {
        res.status(422).json({ type: 'nmb_analysis_invalid', message: 'Upload a .csv file.' });
        return;
      }
      if (file.size > config.analysis.maxUploadBytes) {
        res.status(413).json({ type: 'nmb_analysis_too_large', message: 'The file is too large.' });
        return;
      }
      const identity = resolveIdentity(req, config);
      const actor = actorOf(req, user);
      try {
        const ds = await analysis.upload(
          file.originalname,
          file.buffer,
          user,
          identity?.ctx.department,
        );
        await audit({
          action: 'nmb_analysis.dataset_uploaded',
          actor,
          target: { type: 'nmb_dataset', id: ds.id },
          outcome: 'success',
          metadata: {
            rows: ds.rows,
            columns: ds.columns.length,
            sensitive_columns: ds.columns.filter((c) => c.sensitive).length,
            bytes: file.size,
          },
        });
        res.status(201).json(ds);
      } catch (error) {
        await audit({
          action: 'nmb_analysis.dataset_uploaded',
          actor,
          target: { type: 'nmb_dataset' },
          outcome: 'failure',
          metadata: { bytes: file.size },
        });
        if (error instanceof ScannerError && error.kind === 'bad_request') {
          res.status(422).json({
            type: 'nmb_analysis_invalid',
            message: 'The file could not be read as a CSV.',
          });
          return;
        }
        fail(res, error);
      }
    }) as RequestHandler,

    /** GET /datasets */
    list: (async (req, res) => {
      const user = identify(req, res);
      if (!user) {
        return;
      }
      try {
        noStore(res);
        res.json({ items: await analysis.list(user) });
      } catch (error) {
        fail(res, error);
      }
    }) as RequestHandler,

    /** GET /datasets/:id */
    get: (async (req, res) => {
      const user = identify(req, res, DATASET_ID_RE, req.params.id);
      if (!user) {
        return;
      }
      try {
        noStore(res);
        res.json(await analysis.get(req.params.id, user));
      } catch (error) {
        fail(res, error);
      }
    }) as RequestHandler,

    /** DELETE /datasets/:id */
    remove: (async (req, res) => {
      const user = identify(req, res, DATASET_ID_RE, req.params.id);
      if (!user) {
        return;
      }
      const actor = actorOf(req, user);
      try {
        await analysis.remove(req.params.id, user);
        await audit({
          action: 'nmb_analysis.dataset_deleted',
          actor,
          target: { type: 'nmb_dataset', id: req.params.id },
          outcome: 'success',
        });
        res.json({ deleted: true });
      } catch (error) {
        await audit({
          action: 'nmb_analysis.dataset_deleted',
          actor,
          target: { type: 'nmb_dataset', id: req.params.id },
          outcome: 'failure',
        });
        fail(res, error);
      }
    }) as RequestHandler,

    /** POST /datasets/:id/synthesize  { columns, rows?, seed? } */
    synthesize: (async (req, res) => {
      const user = identify(req, res, DATASET_ID_RE, req.params.id);
      if (!user) {
        return;
      }
      const body = (req.body ?? {}) as { columns?: unknown; rows?: unknown; seed?: unknown };
      const columns = body.columns;
      if (
        !Array.isArray(columns) ||
        columns.length === 0 ||
        columns.length > MAX_COLUMNS ||
        !columns.every((c) => typeof c === 'string' && c.length > 0 && c.length <= MAX_COLUMN_NAME)
      ) {
        res
          .status(400)
          .json({ type: 'nmb_analysis_invalid', message: 'Choose at least one column.' });
        return;
      }
      const rows = body.rows === undefined ? 100 : body.rows;
      if (typeof rows !== 'number' || !Number.isInteger(rows) || rows < 1 || rows > MAX_ROWS) {
        res.status(400).json({ type: 'nmb_analysis_invalid', message: 'Invalid row count.' });
        return;
      }
      const seed =
        typeof body.seed === 'number' && Number.isInteger(body.seed) ? body.seed : undefined;
      const actor = actorOf(req, user);
      try {
        const ds = await analysis.synthesize(req.params.id, {
          user,
          columns: columns as string[],
          rows,
          ...(seed !== undefined ? { seed } : {}),
        });
        await audit({
          action: 'nmb_analysis.synthesized',
          actor,
          target: { type: 'nmb_dataset', id: req.params.id },
          outcome: 'success',
          metadata: { columns: columns.length, rows },
        });
        res.json(ds);
      } catch (error) {
        await audit({
          action: 'nmb_analysis.synthesized',
          actor,
          target: { type: 'nmb_dataset', id: req.params.id },
          outcome: 'failure',
        });
        fail(res, error);
      }
    }) as RequestHandler,

    /** GET /datasets/:id/synthetic: the only dataset content that may be shown to a model. */
    synthetic: (async (req, res) => {
      const user = identify(req, res, DATASET_ID_RE, req.params.id);
      if (!user) {
        return;
      }
      try {
        noStore(res);
        res.json(await analysis.synthetic(req.params.id, user));
      } catch (error) {
        fail(res, error);
      }
    }) as RequestHandler,

    /** POST /datasets/:id/execute  { code, target } */
    execute: (async (req, res) => {
      const user = identify(req, res, DATASET_ID_RE, req.params.id);
      if (!user) {
        return;
      }
      const body = (req.body ?? {}) as { code?: unknown; target?: unknown };
      if (body.target !== 'synthetic' && body.target !== 'real') {
        res.status(400).json({ type: 'nmb_analysis_invalid', message: 'Invalid target.' });
        return;
      }
      if (typeof body.code !== 'string' || body.code.trim().length === 0) {
        res.status(400).json({ type: 'nmb_analysis_invalid', message: 'Provide code to run.' });
        return;
      }
      if (body.code.length > config.analysis.maxCodeChars) {
        res.status(413).json({ type: 'nmb_analysis_too_large', message: 'The code is too long.' });
        return;
      }
      const code = body.code;
      const target: AnalysisTarget = body.target === 'real' ? 'real' : 'synthetic';
      const actor = actorOf(req, user);
      try {
        const run = await analysis.execute(req.params.id, { user, code, target });
        await audit({
          action: 'nmb_analysis.executed',
          actor,
          target: { type: 'nmb_run', id: run.id },
          outcome: 'success',
          metadata: {
            dataset: req.params.id,
            target,
            status: run.status,
            code_sha256: hash(code),
            code_chars: code.length,
            violations: run.violations.length,
            files: run.files.length,
            duration_ms: run.duration_ms,
          },
        });
        noStore(res);
        res.json(run);
      } catch (error) {
        await audit({
          action: 'nmb_analysis.executed',
          actor,
          target: { type: 'nmb_dataset', id: req.params.id },
          outcome: 'failure',
          metadata: { target, code_sha256: hash(code), code_chars: code.length },
        });
        fail(res, error);
      }
    }) as RequestHandler,

    /** GET /runs/:id */
    getRun: (async (req, res) => {
      const user = identify(req, res, RUN_ID_RE, req.params.id);
      if (!user) {
        return;
      }
      try {
        noStore(res);
        res.json(await analysis.getRun(req.params.id, user));
      } catch (error) {
        fail(res, error);
      }
    }) as RequestHandler,

    /** GET /runs/:id/files/:name: download only, never rendered inline. */
    getRunFile: (async (req, res) => {
      const user = identify(req, res, RUN_ID_RE, req.params.id);
      if (!user) {
        return;
      }
      const name = req.params.name;
      if (!FILE_NAME_RE.test(name) || name.includes('..')) {
        res.status(400).json({ message: 'Invalid file name' });
        return;
      }
      try {
        const file = await analysis.getRunFile(req.params.id, name, user);
        noStore(res);
        res.setHeader('Content-Type', file.contentType);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/"/g, '')}"`);
        if (file.size != null) {
          res.setHeader('Content-Length', String(file.size));
        }
        if (!file.body) {
          res.end();
          return;
        }
        const reader = file.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          res.write(Buffer.from(value));
        }
        res.end();
      } catch (error) {
        if (res.headersSent) {
          res.end();
          return;
        }
        fail(res, error);
      }
    }) as RequestHandler,

    /** GET /limits */
    limits: (async (_req, res) => {
      try {
        res.json(await analysis.limits());
      } catch (error) {
        fail(res, error);
      }
    }) as RequestHandler,
  };
}
