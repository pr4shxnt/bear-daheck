'use strict';

/**
 * tests/logger.test.js
 *
 * Unit tests for the logger module.
 */

const logger = require('../bot/logger');

describe('logger', () => {
  let stdoutSpy;
  let stderrSpy;

  beforeEach(() => {
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => {});
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => {});
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  test('info() writes JSON-line to stdout', () => {
    logger.info('test message', { foo: 'bar' });
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const line = stdoutSpy.mock.calls[0][0];
    const parsed = JSON.parse(line);
    expect(parsed.level).toBe('info');
    expect(parsed.message).toBe('test message');
    expect(parsed.foo).toBe('bar');
    expect(parsed.ts).toBeDefined();
  });

  test('error() writes JSON-line to stderr', () => {
    logger.error('something broke', { code: 500 });
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const line = stderrSpy.mock.calls[0][0];
    const parsed = JSON.parse(line);
    expect(parsed.level).toBe('error');
    expect(parsed.message).toBe('something broke');
    expect(parsed.code).toBe(500);
  });

  test('warn() writes JSON-line to stderr', () => {
    logger.warn('careful', {});
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const line = stderrSpy.mock.calls[0][0];
    const parsed = JSON.parse(line);
    expect(parsed.level).toBe('warn');
  });

  test('log entries include ISO timestamp', () => {
    logger.info('timestamp test');
    const line = stdoutSpy.mock.calls[0][0];
    const parsed = JSON.parse(line);
    expect(new Date(parsed.ts).toISOString()).toBe(parsed.ts);
  });

  test('extra data fields are merged into the log entry', () => {
    logger.info('extra data', { alpha: 1, beta: 'two' });
    const line = stdoutSpy.mock.calls[0][0];
    const parsed = JSON.parse(line);
    expect(parsed.alpha).toBe(1);
    expect(parsed.beta).toBe('two');
  });
});
