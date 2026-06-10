// Combined end-to-end load test: real sessions minted by identity-service
// (:8080) spent against ledger-service (:8081), both on the shared platform
// stack. Run via `make perf` (which preps the admin user first).
//
// Scenarios — a mixed workload of 100 concurrent customers with think time,
// plus the platform acting on their accounts:
//   customer_journey — each VU is a signed-in customer checking their account
//                      (identity /me) and their points (ledger /me/points)
//   purchases        — the rewards platform awards points for orders (admin)
//   redemptions      — the rewards platform redeems points (admin)
//   logins           — fresh customer sign-ins arriving throughout (bcrypt)
//
// SMOKE=1 shrinks every scenario for a fast end-to-end check of the harness.

import http from 'k6/http';
import { check, sleep } from 'k6';
import exec from 'k6/execution';

const IDENTITY_URL = __ENV.IDENTITY_URL || 'http://localhost:8080';
const LEDGER_URL = __ENV.LEDGER_URL || 'http://localhost:8081';
const ADMIN_EMAIL = __ENV.ADMIN_EMAIL || 'perf-admin@example.com';
const ADMIN_PASSWORD = __ENV.ADMIN_PASSWORD || 'perf-admin-correct-horse';
const SMOKE = __ENV.SMOKE === '1';
const CUSTOMER_POOL = SMOKE ? 10 : 100;
const PASSWORD = 'perf-correct-horse';

const JSON_HEADERS = { headers: { 'Content-Type': 'application/json' } };

const scenarios = {
  customer_journey: {
    executor: 'ramping-vus',
    exec: 'customerJourney',
    startVUs: 0,
    stages: SMOKE
      ? [{ duration: '10s', target: 5 }]
      : [
          { duration: '30s', target: 100 },
          { duration: '2m', target: 100 },
          { duration: '30s', target: 0 },
        ],
  },
  purchases: {
    executor: 'constant-arrival-rate',
    exec: 'awardForPurchase',
    rate: SMOKE ? 2 : 10,
    timeUnit: '1s',
    duration: SMOKE ? '10s' : '3m',
    preAllocatedVUs: SMOKE ? 5 : 20,
  },
  redemptions: {
    executor: 'constant-arrival-rate',
    exec: 'redeemPoints',
    rate: SMOKE ? 1 : 3,
    timeUnit: '1s',
    duration: SMOKE ? '10s' : '3m',
    preAllocatedVUs: SMOKE ? 5 : 10,
  },
  logins: {
    executor: 'constant-arrival-rate',
    exec: 'login',
    rate: SMOKE ? 1 : 5,
    timeUnit: '1s',
    duration: SMOKE ? '10s' : '3m',
    preAllocatedVUs: SMOKE ? 3 : 15,
  },
};

export const options = {
  // Setup registers, logs in, and seeds CUSTOMER_POOL customers; bcrypt makes
  // the identity calls deliberately slow, so give it room.
  setupTimeout: '180s',
  scenarios,
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{scenario:customer_journey}': ['p(99)<300'],
    'http_req_duration{scenario:purchases}': ['p(99)<500'],
    'http_req_duration{scenario:redemptions}': ['p(99)<500'],
    'http_req_duration{scenario:logins}': ['p(99)<800'],
  },
};

function bearer(token) {
  return { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } };
}

function loginRequest(email, password) {
  const body = JSON.stringify({ email, password });
  return http.post(`${IDENTITY_URL}/login`, body, JSON_HEADERS);
}

function postPosting(adminToken, path, userRef, amount, reference) {
  const body = JSON.stringify({ userRef, amount, reference });
  return http.post(`${LEDGER_URL}${path}`, body, bearer(adminToken));
}

export function setup() {
  const runId = Date.now();

  // The admin is a real identity user promoted by make perf; its session
  // token must carry the admin role for the ledger posting endpoints.
  const adminSession = loginRequest(ADMIN_EMAIL, ADMIN_PASSWORD);
  if (adminSession.status !== 200) {
    exec.test.abort(`admin login failed: ${adminSession.status} ${adminSession.body}`);
  }
  const adminToken = adminSession.json('accessToken');

  const customers = [];
  for (let i = 0; i < CUSTOMER_POOL; i++) {
    const email = `perf-e2e-${runId}-${i}@example.com`;
    const body = JSON.stringify({ email, displayName: 'Perf Customer', password: PASSWORD });

    const registered = http.post(`${IDENTITY_URL}/users`, body, JSON_HEADERS);
    if (registered.status !== 201) {
      exec.test.abort(`registering ${email} failed: ${registered.status} ${registered.body}`);
    }
    const userRef = registered.json('externalRef');

    const session = loginRequest(email, PASSWORD);
    if (session.status !== 200) {
      exec.test.abort(`logging in ${email} failed: ${session.status} ${session.body}`);
    }

    // Seed a balance so redemptions never hit an insufficient-points refusal:
    // this test measures the mixed workload, not overdraft handling.
    const seeded = postPosting(adminToken, '/points/award', userRef, 10000, `e2e-seed-${runId}-${i}`);
    if (seeded.status !== 200) {
      exec.test.abort(`seeding points for ${email} failed: ${seeded.status} ${seeded.body}`);
    }

    customers.push({ email, userRef, accessToken: session.json('accessToken') });
  }

  return { runId, adminToken, customers };
}

// A signed-in customer checking their account and their points balance — one
// identity read and one ledger read per iteration, with think time so 100 VUs
// model 100 concurrent users rather than a request flood.
export function customerJourney(data) {
  const c = data.customers[(exec.vu.idInTest - 1) % data.customers.length];

  const account = http.get(`${IDENTITY_URL}/me`, bearer(c.accessToken));
  check(account, { 'own account returned': (r) => r.status === 200 });

  const points = http.get(`${LEDGER_URL}/me/points`, bearer(c.accessToken));
  check(points, { 'own points returned': (r) => r.status === 200 });

  sleep(1);
}

export function awardForPurchase(data) {
  const i = exec.scenario.iterationInTest;
  const c = data.customers[i % data.customers.length];
  const res = postPosting(data.adminToken, '/points/award', c.userRef, 10, `e2e-award-${data.runId}-${i}`);
  check(res, { 'points awarded for purchase': (r) => r.status === 200 });
}

export function redeemPoints(data) {
  const i = exec.scenario.iterationInTest;
  const c = data.customers[i % data.customers.length];
  const res = postPosting(data.adminToken, '/points/deduct', c.userRef, 5, `e2e-redeem-${data.runId}-${i}`);
  check(res, { 'points redeemed': (r) => r.status === 200 });
}

export function login(data) {
  const i = exec.scenario.iterationInTest;
  const c = data.customers[i % data.customers.length];
  const res = loginRequest(c.email, PASSWORD);
  check(res, { 'session issued': (r) => r.status === 200 });
}
