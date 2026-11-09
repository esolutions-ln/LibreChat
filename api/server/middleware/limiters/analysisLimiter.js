const rateLimit = require('express-rate-limit');
const { limiterCache, removePorts } = require('@librechat/api');

/**
 * Limits how often one user may start an analysis run (synthetic or real). Each run executes
 * model-written code next to real data, so bursts are bounded per user. Values come from the NMB
 * config (`NMB_ANALYSIS_EXECUTE_MAX`, `NMB_ANALYSIS_EXECUTE_WINDOW_MINUTES`).
 *
 * @param {{ executeRateMax: number, executeRateWindowMinutes: number }} analysis
 * @param {{ name?: string, message?: string }} [opts] separate counter and wording for other routes (e.g. report export)
 */
const createAnalysisExecuteLimiter = (analysis, opts = {}) => {
  const {
    name = 'nmb_analysis_execute_limiter',
    message = 'Too many analysis runs. Try again later.',
  } = opts;
  const max = analysis.executeRateMax;
  const windowInMinutes = analysis.executeRateWindowMinutes;

  return rateLimit({
    windowMs: windowInMinutes * 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.user?.id ?? removePorts(req),
    store: limiterCache(name),
    handler: (_req, res) => {
      res.status(429).json({
        type: 'nmb_analysis_rate_limited',
        message,
        max,
        windowInMinutes,
      });
    },
  });
};

module.exports = { createAnalysisExecuteLimiter };
