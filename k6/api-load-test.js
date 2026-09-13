// k6 HTTP load test (hardening Phase 21, A12 #24) — run against staging via
// the reusable smart-pet-ci/.github/workflows/k6-load-test.yml, or locally:
//
//   TARGET_URL=https://api-staging.example.com \
//   LOAD_TEST_EMAIL=... LOAD_TEST_PASSWORD=... \
//   k6 run k6/api-load-test.js
//
// Two scenarios, not one, because the API isn't uniformly rate-limited:
//   - infra_health: unauthenticated, unlimited (/health, /ready) — the raw
//     capacity of the ALB/ECS/DB-pool stack, unconstrained by app logic.
//   - authenticated_reads: real breeder reads, but held to ~480 req/min
//     against ONE logged-in user — `breederLimiter` caps a single
//     authenticated user at 600/min (Phase 20, A10). Pushing past that with
//     one token would just load-test the rate limiter, not the API; to
//     validate capacity beyond one tenant's ceiling, seed several
//     LOAD_TEST_EMAIL_N accounts and add more VUs each authenticated as a
//     different one — not done here to avoid needing N throwaway accounts
//     provisioned in staging for a first pass.
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = __ENV.TARGET_URL;
if (!BASE) throw new Error('TARGET_URL is required');

export const options = {
  scenarios: {
    infra_health: {
      executor: 'constant-arrival-rate',
      exec: 'infraHealth',
      rate: 50, // req/s
      timeUnit: '1s',
      duration: '2m',
      preAllocatedVUs: 20,
      maxVUs: 50,
    },
    authenticated_reads: {
      executor: 'constant-arrival-rate',
      exec: 'authenticatedReads',
      rate: 8, // req/s ≈ 480/min — safely under breederLimiter's 600/min/user
      timeUnit: '1s',
      duration: '2m',
      preAllocatedVUs: 10,
      maxVUs: 20,
    },
  },
  thresholds: {
    'http_req_failed{scenario:infra_health}': ['rate<0.01'],
    'http_req_duration{scenario:infra_health}': ['p(95)<300', 'p(99)<800'],
    'http_req_failed{scenario:authenticated_reads}': ['rate<0.01'],
    'http_req_duration{scenario:authenticated_reads}': ['p(95)<500', 'p(99)<1200'],
  },
};

// Runs once regardless of VU count — logging in per-iteration would itself
// trip authLimiter (5/min/IP, Phase 20).
export function setup() {
  const email = __ENV.LOAD_TEST_EMAIL;
  const password = __ENV.LOAD_TEST_PASSWORD;
  if (!email || !password) {
    console.warn(
      'LOAD_TEST_EMAIL/PASSWORD unset — authenticated_reads will fail auth (401s expected)',
    );
    return { token: null };
  }
  const res = http.post(`${BASE}/api/auth/login`, JSON.stringify({ email, password }), {
    headers: { 'Content-Type': 'application/json' },
  });
  check(res, { 'login succeeded': (r) => r.status === 200 });
  const token = res.status === 200 ? res.json('accessToken') : null;
  return { token };
}

export function infraHealth() {
  const res = http.get(`${BASE}/ready`);
  check(res, { 'status 200': (r) => r.status === 200 });
  sleep(0.1);
}

export function authenticatedReads(data) {
  const headers = data.token ? { Authorization: `Bearer ${data.token}` } : {};
  const res = http.get(`${BASE}/api/breeder/animals`, { headers });
  check(res, { 'status 200': (r) => r.status === 200 });
  sleep(0.1);
}
