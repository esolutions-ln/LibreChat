const express = require('express');
const { getNmb } = require('~/server/services/nmb');
const { requireJwtAuth } = require('~/server/middleware');

const router = express.Router();
router.use(requireJwtAuth);

const h = (name) => (req, res, next) => getNmb().handlers[name](req, res, next);

/** Any authenticated user */
router.get('/me', h('me'));
router.get('/submissions/:id', h('mySubmission'));
router.post('/unmask', h('unmask'));

/** Reviewers only: capability `review:prompts`, then self-review is refused per review. */
const reviewer = h('requireReviewer');
router.get('/reviews', reviewer, h('listReviews'));
router.get('/reviews/:id', reviewer, h('getReview'));
router.get('/reviews/:id/original', reviewer, h('getOriginal'));
router.post('/reviews/:id/approve', reviewer, h('approve'));
router.post('/reviews/:id/reject', reviewer, h('reject'));
router.get('/blocklist', reviewer, h('getBlocklist'));
router.post('/blocklist', reviewer, h('addBlocklist'));

/**
 * Synthetic-data analysis. Any authenticated user; the handlers 404 unless the gateway and
 * `NMB_ANALYSIS_ENABLED` are on, and every call is scoped to the session user.
 */
const multer = require('multer');

const a = (name) => (req, res, next) => getNmb().analysisHandlers[name](req, res, next);

/** Buffers one CSV in memory, bounded by `NMB_ANALYSIS_MAX_UPLOAD_BYTES`. Never written to disk here. */
const csvUpload = (req, res, next) => {
  const limit = getNmb().config.analysis.maxUploadBytes;
  multer({ storage: multer.memoryStorage(), limits: { fileSize: limit, files: 1 } }).single('file')(
    req,
    res,
    (err) => {
      if (!err) {
        return next();
      }
      const tooLarge = err.code === 'LIMIT_FILE_SIZE';
      return res.status(tooLarge ? 413 : 400).json({
        type: tooLarge ? 'nmb_analysis_too_large' : 'nmb_analysis_invalid',
        message: tooLarge ? 'The file is too large.' : 'Upload a single .csv file.',
      });
    },
  );
};

const analysis = express.Router();
analysis.use(a('gate'));
analysis.get('/limits', a('limits'));
analysis.get('/datasets', a('list'));
analysis.post('/datasets', csvUpload, a('upload'));
analysis.get('/datasets/:id', a('get'));
analysis.delete('/datasets/:id', a('remove'));
analysis.post('/datasets/:id/synthesize', a('synthesize'));
analysis.get('/datasets/:id/synthetic', a('synthetic'));
analysis.post('/datasets/:id/execute', a('execute'));
analysis.get('/runs/:id', a('getRun'));
analysis.get('/runs/:id/files/:name', a('getRunFile'));
router.use('/analysis', analysis);

module.exports = router;
