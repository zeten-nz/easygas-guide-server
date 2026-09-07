/**
 * Sets a metrics token/flag BEFORE src/config/env.ts is parsed. Must be imported
 * as the FIRST import of the observability suite so env captures these values.
 */
process.env.METRICS_ENABLED = 'true';
process.env.METRICS_TOKEN = 'test-metrics-token-0123456789abcdef';
export const METRICS_TOKEN = process.env.METRICS_TOKEN;
