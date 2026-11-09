const express = require('express');
const request = require('supertest');

jest.mock('@librechat/api', () => ({
  limiterCache: jest.fn(() => undefined),
  removePorts: (req) => req.ip,
}));

const { createAnalysisExecuteLimiter } = require('./analysisLimiter');

const buildApp = (user, analysis = { executeRateMax: 2, executeRateWindowMinutes: 15 }) => {
  const limiter = createAnalysisExecuteLimiter(analysis);
  const app = express();
  app.post(
    '/execute',
    (req, _res, next) => {
      req.user = typeof user === 'function' ? user(req) : user;
      next();
    },
    limiter,
    (_req, res) => res.status(200).json({ ok: true }),
  );
  return app;
};

describe('analysis execute limiter', () => {
  it('allows up to the configured maximum, then answers 429 with the limits', async () => {
    const app = buildApp({ id: 'u1' });
    expect((await request(app).post('/execute')).status).toBe(200);
    expect((await request(app).post('/execute')).status).toBe(200);
    const res = await request(app).post('/execute');
    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      type: 'nmb_analysis_rate_limited',
      message: 'Too many analysis runs. Try again later.',
      max: 2,
      windowInMinutes: 15,
    });
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('counts each user separately', async () => {
    const app = buildApp((req) => ({ id: req.get('x-user') }));
    for (let i = 0; i < 2; i++) {
      await request(app).post('/execute').set('x-user', 'a');
    }
    expect((await request(app).post('/execute').set('x-user', 'a')).status).toBe(429);
    expect((await request(app).post('/execute').set('x-user', 'b')).status).toBe(200);
  });

  it('uses its own store name and message when given (report export)', async () => {
    const { limiterCache } = require('@librechat/api');
    const limiter = createAnalysisExecuteLimiter(
      { executeRateMax: 1, executeRateWindowMinutes: 1 },
      { name: 'nmb_report_export_limiter', message: 'Too many exports. Try again later.' },
    );
    expect(limiterCache).toHaveBeenCalledWith('nmb_report_export_limiter');
    const app = express();
    app.post(
      '/export',
      (req, _res, next) => {
        req.user = { id: 'u3' };
        next();
      },
      limiter,
      (_req, res) => res.status(200).json({ ok: true }),
    );
    await request(app).post('/export');
    const res = await request(app).post('/export');
    expect(res.status).toBe(429);
    expect(res.body.message).toBe('Too many exports. Try again later.');
  });

  it('takes its limits from the config', async () => {
    const app = buildApp({ id: 'u2' }, { executeRateMax: 1, executeRateWindowMinutes: 1 });
    expect((await request(app).post('/execute')).status).toBe(200);
    const res = await request(app).post('/execute');
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ max: 1, windowInMinutes: 1 });
  });
});
