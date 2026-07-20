'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');

const JOBS_DIR = path.join(__dirname, '..', 'tmp-jobs');
// Local single-user tool: no DB, jobs live in memory and on disk only for
// this process's lifetime. Finished/failed jobs are swept after a grace
// period so a long-running dev server doesn't accumulate temp audio forever.
const CLEANUP_DELAY_MS = 30 * 60 * 1000;

/** @type {Map<string, object>} */
const jobs = new Map();

// Emits 'update' with a jobId whenever that job's progress/status changes,
// so the long-poll status route (server.js, mirroring the repo's existing
// long-polling-nodejs pattern) can resolve held requests immediately instead
// of busy-polling this module.
const emitter = new EventEmitter();
emitter.setMaxListeners(0);

function createJob(total) {
  const id = crypto.randomUUID();
  const dir = path.join(JOBS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });

  const job = {
    id,
    dir,
    status: 'processing', // 'processing' | 'done' | 'error'
    total,
    completed: 0,
    error: null,
    outputPath: null,
  };
  jobs.set(id, job);
  return job;
}

function getJob(id) {
  return jobs.get(id) || null;
}

function incrementCompleted(id) {
  const job = jobs.get(id);
  if (!job) return;
  job.completed += 1;
  emitter.emit('update', id);
}

function markDone(id, outputPath) {
  const job = jobs.get(id);
  if (!job) return;
  job.status = 'done';
  job.outputPath = outputPath;
  scheduleCleanup(id);
  emitter.emit('update', id);
}

function markError(id, message) {
  const job = jobs.get(id);
  if (!job) return;
  job.status = 'error';
  job.error = message;
  scheduleCleanup(id);
  emitter.emit('update', id);
}

function scheduleCleanup(id) {
  setTimeout(() => {
    const job = jobs.get(id);
    if (!job) return;
    fs.rm(job.dir, { recursive: true, force: true }, () => {});
    jobs.delete(id);
  }, CLEANUP_DELAY_MS).unref();
}

module.exports = { createJob, getJob, incrementCompleted, markDone, markError, JOBS_DIR, emitter };
