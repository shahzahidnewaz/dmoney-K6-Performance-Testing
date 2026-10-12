import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.4/index.js';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:5000';
const SECRET   = __ENV.PARTNER_KEY || 'ROADTOSDET';
const OTP      = __ENV.OTP || '0000';
const RATE     = Number(__ENV.RATE || 2);
const AMOUNT   = Number(__ENV.AMOUNT || 10);
const PHASE_S  = Number(__ENV.PHASE_SECONDS || 30);
const DEBUG    = __ENV.DEBUG === 'true';
const SEED          = __ENV.SEED === 'true';
const SYSTEM_PASS   = __ENV.SYSTEM_PASSWORD || '1234';
const SEED_AGENT    = Number(__ENV.SEED_AGENT_AMOUNT || 10000);
const SEED_CUSTOMER = Number(__ENV.SEED_CUSTOMER_AMOUNT || 3000);
let debugLogged = 0;

const U = JSON.parse(open('./config/users.json'));
const ROLE_KEYS = Object.keys(U);

const PHASES = {
  p1: [['sendmoney', 'customer1', 'customer2'], ['payment', 'customer2', 'merchant1']],
  p2: [['sendmoney', 'customer2', 'customer1'], ['deposit', 'agent1', 'customer2'], ['payment', 'customer1', 'merchant1']],
  p3: [['deposit', 'agent1', 'customer1'], ['deposit', 'agent2', 'customer2'], ['sendmoney', 'customer1', 'customer2'], ['payment', 'customer2', 'merchant2']],
  p4: [['payment', 'agent1', 'merchant1'], ['payment', 'agent2', 'merchant2'], ['payment', 'customer1', 'merchant1'], ['payment', 'customer2', 'merchant2']],
};
const API = {
  deposit:   { path: '/transaction/deposit',   msg: 'Deposit successful' },
  sendmoney: { path: '/transaction/sendmoney', msg: 'Send money successful' },
  payment:   { path: '/transaction/payment',   msg: 'Payment successful' },
};

const apiPhaseDur  = {};
const apiPhaseFail = {};
for (const api of Object.keys(API)) {
  for (const ph of Object.keys(PHASES)) {
    apiPhaseDur[`${api}_${ph}`]  = new Trend(`dur_${api}_${ph}`, true);
    apiPhaseFail[`${api}_${ph}`] = new Rate(`fail_${api}_${ph}`);
  }
}

const scenarios = {};
let n = 0;
Object.entries(PHASES).forEach(([phase, acts], idx) => {
  acts.forEach(([api, from, to]) => {
    scenarios[`${phase}_${api}_${from}_to_${to}`] = {
      executor: 'constant-arrival-rate',
      rate: RATE, timeUnit: '1s',
      duration: `${PHASE_S}s`,
      startTime: `${idx * PHASE_S}s`,
      preAllocatedVUs: Math.max(5, RATE * 3),
      maxVUs: Math.max(20, RATE * 10),
      exec: 'transact',
      env: { PHASE: phase, API: api, FROM: from, TO: to },
    };
    n++;
  });
});

export const options = {
  scenarios,
  thresholds: {
    http_req_failed:   [{ threshold: 'rate<0.01' }],
    http_req_duration: ['p(95)<1000'],
    checks:            ['rate>=0.99'],
    'http_req_failed{api:deposit}':   ['rate<0.01'],
    'http_req_failed{api:sendmoney}': ['rate<0.01'],
    'http_req_failed{api:payment}':   ['rate<0.01'],
    'http_req_duration{api:deposit}':   ['p(95)<1000'],
    'http_req_duration{api:sendmoney}': ['p(95)<1000'],
    'http_req_duration{api:payment}':   ['p(95)<1000'],
    'checks{api:deposit}':   ['rate>=0.99'],
    'checks{api:sendmoney}': ['rate>=0.99'],
    'checks{api:payment}':   ['rate>=0.99'],
    'http_reqs{api:deposit}':   ['count>=0'],
    'http_reqs{api:sendmoney}': ['count>=0'],
    'http_reqs{api:payment}':   ['count>=0'],
  },
};

function authenticate(user) {
  const headers = { 'Content-Type': 'application/json' };
  const login = http.post(`${BASE_URL}/user/login`,
    JSON.stringify({ phone_number: user.phone, password: user.password }),
    { headers, tags: { name: 'login' }, responseCallback: http.expectedStatuses(200) });
  if (login.status !== 200) throw new Error(`login failed for ${user.phone}: ${login.status} ${login.body}`);

  let body = login.json();
  if (body.token) return body.token;

  const v = http.post(`${BASE_URL}/user/verify-otp?env=dev`,
    JSON.stringify({ identifier: user.phone, otp: OTP }),
    { headers, tags: { name: 'verify_otp' }, responseCallback: http.expectedStatuses(200) });
  if (v.status !== 200 || !v.json('token')) throw new Error(`OTP verify failed for ${user.phone}: ${v.status} ${v.body}`);
  return v.json('token');
}

const headersFor = (token) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-AUTH-SECRET-KEY': SECRET });

function getBalance(token, phone) {
  const r = http.get(`${BASE_URL}/transaction/balance/${phone}`,
    { headers: headersFor(token), tags: { name: 'seed_balance' }, responseCallback: http.expectedStatuses(200) });
  if (r.status !== 200) throw new Error(`balance lookup failed for ${phone}: ${r.status} ${r.body}`);
  return Number(r.json('balance'));
}

function seedDeposit(token, from, to, amount) {
  const r = http.post(`${BASE_URL}/transaction/deposit`,
    JSON.stringify({ from_account: from, to_account: to, amount }),
    { headers: headersFor(token), tags: { name: 'seed_deposit' }, responseCallback: http.expectedStatuses(201) });
  if (r.status !== 201) throw new Error(`seed deposit ${from}->${to} failed: ${r.status} ${r.body}`);
}

function topUp(token, from, to, target) {
  const need = target - getBalance(token, to);
  if (need >= 10) seedDeposit(token, from, to, need);
}

function seedPayment(token, from, to, amount) {
  const r = http.post(`${BASE_URL}/transaction/payment`,
    JSON.stringify({ from_account: from, to_account: to, amount }),
    { headers: headersFor(token), tags: { name: 'seed_payment' }, responseCallback: http.expectedStatuses(201) });
  if (r.status !== 201) throw new Error(`seed payment ${from}->${to} failed: ${r.status} ${r.body}`);
}

function normalize(tokens, customer) {
  const phone = U[customer].phone;
  const bal = getBalance(tokens[customer], phone);
  if (bal < SEED_CUSTOMER) topUp(tokens.agent1, U.agent1.phone, phone, SEED_CUSTOMER);
  const excess = bal - SEED_CUSTOMER - 20;
  if (excess >= 10) seedPayment(tokens[customer], phone, U.merchant1.phone, excess);
}

function seed(tokens) {
  const sys = authenticate({ phone: 'SYSTEM', password: SYSTEM_PASS });
  for (const a of ['agent1', 'agent2']) topUp(sys, 'SYSTEM', U[a].phone, SEED_AGENT);
  for (const c of ['customer1', 'customer2']) normalize(tokens, c);
}

export function setup() {
  const tokens = {};
  for (const k of ROLE_KEYS) tokens[k] = authenticate(U[k]);
  if (SEED) seed(tokens);
  return { tokens };
}

export function transact(data) {
  const { PHASE, API: api, FROM, TO } = __ENV;
  const spec = API[api];
  const res = http.post(
    `${BASE_URL}${spec.path}`,
    JSON.stringify({ from_account: U[FROM].phone, to_account: U[TO].phone, amount: AMOUNT }),
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${data.tokens[FROM]}`,
        'X-AUTH-SECRET-KEY': SECRET,
      },
      tags: { api, phase: PHASE, name: api },
      responseCallback: http.expectedStatuses(201),
    });

  let body = {};
  try { body = res.json(); } catch (e) { }

  const ok = check(res, {
    'status is 201':               (r) => r.status === 201,
    'transaction successful':      (r) => r.status === 201 && !body.error && typeof body.message === 'string' && /successful/i.test(body.message),
    'transaction id returned':     () => typeof body.trnxId === 'string' && body.trnxId.length > 0,
    'expected success message':    () => body.message === spec.msg,
  }, { api, phase: PHASE });

  if (DEBUG && !ok && debugLogged < 3) {
    debugLogged++;
    console.error(`FAIL ${api} ${FROM}->${TO} status=${res.status} body=${String(res.body).slice(0, 300)}`);
  }

  apiPhaseDur[`${api}_${PHASE}`].add(res.timings.duration);
  apiPhaseFail[`${api}_${PHASE}`].add(!ok || res.status !== 201);
  sleep(0);
}

const val = (d, name, key) => (d.metrics[name] && d.metrics[name].values[key] !== undefined ? d.metrics[name].values[key] : null);
const f = (x, dp = 1) => (x === null ? '-' : Number(x).toFixed(dp));

export function handleSummary(data) {
  const secs = PHASE_S * Object.keys(PHASES).length;
  let md = '# DMoney API comparison\n\n## Overall per API\n\n';
  md += '| API | Requests | Throughput (req/s) | avg ms | p90 ms | p95 ms | max ms | Failure % |\n|---|---|---|---|---|---|---|---|\n';
  for (const api of Object.keys(API)) {
    const reqs = val(data, `http_reqs{api:${api}}`, 'count');
    md += `| ${api} | ${reqs ?? '-'} | ${f(reqs / secs, 2)} | ${f(val(data, `http_req_duration{api:${api}}`, 'avg'))} | ${f(val(data, `http_req_duration{api:${api}}`, 'p(90)'))} | ${f(val(data, `http_req_duration{api:${api}}`, 'p(95)'))} | ${f(val(data, `http_req_duration{api:${api}}`, 'max'))} | ${f((val(data, `http_req_failed{api:${api}}`, 'rate') || 0) * 100, 2)} |\n`;
  }
  md += '\n## Per phase (degradation view): p95 ms / failure % / requests\n\n| API | 0-30s | 30-60s | 60-90s | 90-120s |\n|---|---|---|---|---|\n';
  for (const api of Object.keys(API)) {
    md += `| ${api} |`;
    for (const ph of Object.keys(PHASES)) {
      const d = `dur_${api}_${ph}`, fl = `fail_${api}_${ph}`;
      const m = data.metrics[fl];
      if (!m || !data.metrics[d]) { md += ' n/a |'; continue; }
      const total = (m.values.passes || 0) + (m.values.fails || 0);
      md += ` ${f(val(data, d, 'p(95)'))} / ${f(val(data, fl, 'rate') * 100, 1)}% / ${total} |`;
    }
    md += '\n';
  }
  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }) + '\n' + md,
    'results/summary.json': JSON.stringify(data, null, 2),
    'results/comparison.md': md,
  };
}
