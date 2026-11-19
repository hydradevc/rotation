const BUCKETS = [10, 25, 50, 100, 200, 400, 800, 1600, 3200, 6400, 12800, 30000];

export const meters = {
  latency: new Float64Array(BUCKETS.length + 1),
  requests: 0,
  errors: 0,
  byStatus: new Map(),
  byModel: new Map(),
  byClient: new Map(),
  byProvider: new Map(),
  byError: new Map(),
  startedAt: Date.now()
};

function bump(map, key, n = 1) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + n);
}

export function observe({ ms = 0, status = 0, model, client, provider, error } = {}) {
  meters.requests += 1;
  let index = BUCKETS.length;
  for (let i = 0; i < BUCKETS.length; i++) {
    if (ms <= BUCKETS[i]) {
      index = i;
      break;
    }
  }
  meters.latency[index] += 1;

  const ok = status >= 200 && status < 300;
  if (!ok) meters.errors += 1;
  bump(meters.byStatus, String(status || 'err'));
  bump(meters.byModel, model);
  bump(meters.byClient, client);
  bump(meters.byProvider, provider);
  if (error) bump(meters.byError, String(error).slice(0, 80));
}

export function percentile(p) {
  const total = meters.latency.reduce((a, b) => a + b, 0);
  if (!total) return 0;
  const target = (p / 100) * total;
  let seen = 0;
  for (let i = 0; i < meters.latency.length; i++) {
    seen += meters.latency[i];
    if (seen >= target) return i < BUCKETS.length ? BUCKETS[i] : BUCKETS[BUCKETS.length - 1];
  }
  return BUCKETS[BUCKETS.length - 1];
}

export function top(map, n = 5) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name, count]) => ({ name, count }));
}

export function snapshot() {
  return {
    requests: meters.requests,
    errors: meters.errors,
    errorRate: meters.requests ? (meters.errors / meters.requests) * 100 : 0,
    p50: percentile(50),
    p95: percentile(95),
    p99: percentile(99),
    topModels: top(meters.byModel),
    topClients: top(meters.byClient),
    topProviders: top(meters.byProvider),
    topErrors: top(meters.byError),
    statuses: Object.fromEntries(meters.byStatus),
    uptimeSeconds: Math.round((Date.now() - meters.startedAt) / 1000)
  };
}

export function resetMeters() {
  meters.latency.fill(0);
  meters.requests = 0;
  meters.errors = 0;
  for (const map of [meters.byStatus, meters.byModel, meters.byClient, meters.byProvider, meters.byError]) {
    map.clear();
  }
  meters.startedAt = Date.now();
}

function esc(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
}

export function prometheus(pool) {
  const out = [];
  out.push('# HELP hydra_requests_total Requests served by the rotator');
  out.push('# TYPE hydra_requests_total counter');
  out.push(`hydra_requests_total ${meters.requests}`);
  out.push('# HELP hydra_errors_total Requests answered with an error');
  out.push('# TYPE hydra_errors_total counter');
  out.push(`hydra_errors_total ${meters.errors}`);
  out.push('# HELP hydra_latency_ms Request latency percentiles');
  out.push('# TYPE hydra_latency_ms gauge');
  out.push(`hydra_latency_ms{quantile="0.5"} ${percentile(50)}`);
  out.push(`hydra_latency_ms{quantile="0.95"} ${percentile(95)}`);
  out.push(`hydra_latency_ms{quantile="0.99"} ${percentile(99)}`);

  out.push('# HELP hydra_pool_keys Keys in the pool by state');
  out.push('# TYPE hydra_pool_keys gauge');
  out.push(`hydra_pool_keys{state="active"} ${pool.summary.healthy}`);
  out.push(`hydra_pool_keys{state="total"} ${pool.summary.keys}`);
  out.push(`hydra_pool_keys{state="inflight"} ${pool.summary.inflight}`);
  out.push('# HELP hydra_pool_rpm Requests in the last 60 seconds across the pool');
  out.push('# TYPE hydra_pool_rpm gauge');
  out.push(`hydra_pool_rpm ${pool.summary.rpm}`);
  out.push('# HELP hydra_pool_tpm Tokens in the last 60 seconds across the pool');
  out.push('# TYPE hydra_pool_tpm gauge');
  out.push(`hydra_pool_tpm ${pool.summary.tpm}`);

  out.push('# HELP hydra_key_rpm Per-key requests in the last 60 seconds');
  out.push('# TYPE hydra_key_rpm gauge');
  for (const key of pool.keys) {
    out.push(`hydra_key_rpm{label="${esc(key.label)}",provider="${esc(key.provider)}"} ${key.rpm}`);
  }
  out.push('# HELP hydra_key_errors Per-key consecutive failures');
  out.push('# TYPE hydra_key_errors gauge');
  for (const key of pool.keys) {
    out.push(`hydra_key_errors{label="${esc(key.label)}"} ${key.fails}`);
  }
  out.push('# HELP hydra_uptime_seconds Process uptime');
  out.push('# TYPE hydra_uptime_seconds gauge');
  out.push(`hydra_uptime_seconds ${Math.round(process.uptime())}`);
  return out.join('\n') + '\n';
}