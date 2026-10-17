import http from 'k6/http';
import { check } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:5000';
const SECRET = __ENV.PARTNER_KEY || 'ROADTOSDET';
const OTP = __ENV.OTP || '0000';
const RATE = Number(__ENV.RATE || 2);
const AMOUNT = Number(__ENV.AMOUNT || 10);
const PHASE_SECONDS = Number(__ENV.PHASE_SECONDS || 30);
const RAMP_SECONDS = 2;
const DEBUG = __ENV.DEBUG === 'true';

const users = JSON.parse(open('./config/users.json'));

const APIS = {
  deposit: { path: '/transaction/deposit', message: 'Deposit successful' },
  sendmoney: { path: '/transaction/sendmoney', message: 'Send money successful' },
  payment: { path: '/transaction/payment', message: 'Payment successful' },
};

const PHASES = {
  p1: [
    ['sendmoney', 'customer1', 'customer2'],
    ['payment', 'customer2', 'merchant1'],
  ],
  p2: [
    ['sendmoney', 'customer2', 'customer1'],
    ['deposit', 'agent1', 'customer2'],
    ['payment', 'customer1', 'merchant1'],
  ],
  p3: [
    ['deposit', 'agent1', 'customer1'],
    ['deposit', 'agent2', 'customer2'],
    ['sendmoney', 'customer1', 'customer2'],
    ['payment', 'customer2', 'merchant2'],
  ],
  p4: [
    ['payment', 'agent1', 'merchant1'],
    ['payment', 'agent2', 'merchant2'],
    ['payment', 'customer1', 'merchant1'],
    ['payment', 'customer2', 'merchant2'],
  ],
};

const scenarios = {};
const thresholds = {
  http_req_failed: ['rate<0.01'],
  http_req_duration: ['p(95)<1000'],
  checks: ['rate>=0.99'],
};

for (const api of Object.keys(APIS)) {
  thresholds[`http_req_failed{api:${api}}`] = ['rate<0.01'];
  thresholds[`http_req_duration{api:${api}}`] = ['p(95)<1000'];
  thresholds[`checks{api:${api}}`] = ['rate>=0.99'];
}

Object.entries(PHASES).forEach(([phase, activities], index) => {
  for (const [api, from, to] of activities) {
    scenarios[`${phase}_${api}_${from}_to_${to}`] = {
      executor: 'ramping-arrival-rate',
      startTime: `${index * PHASE_SECONDS}s`,
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: 5,
      maxVUs: 20,
      stages: [
        { duration: `${RAMP_SECONDS}s`, target: RATE },
        { duration: `${PHASE_SECONDS - 2 * RAMP_SECONDS}s`, target: RATE },
        { duration: `${RAMP_SECONDS}s`, target: 0 },
      ],
      env: { PHASE: phase, API: api, FROM: from, TO: to },
    };
    thresholds[`http_req_failed{api:${api},phase:${phase}}`] = ['rate<0.01'];
    thresholds[`http_req_duration{api:${api},phase:${phase}}`] = ['p(95)<1000'];
  }
});

export const options = { scenarios, thresholds };

function authenticate(user) {
  const headers = { 'Content-Type': 'application/json' };
  const login = http.post(
    `${BASE_URL}/user/login`,
    JSON.stringify({ phone_number: user.phone, password: user.password }),
    { headers, tags: { name: 'login' } },
  );
  if (login.status !== 200) {
    throw new Error(`login failed for ${user.phone}: ${login.status} ${login.body}`);
  }

  const verify = http.post(
    `${BASE_URL}/user/verify-otp?env=dev`,
    JSON.stringify({ identifier: user.phone, otp: OTP }),
    { headers, tags: { name: 'verify_otp' } },
  );
  if (verify.status !== 200) {
    throw new Error(`OTP verification failed for ${user.phone}: ${verify.status} ${verify.body}`);
  }
  return verify.json('token');
}

export function setup() {
  const tokens = {};
  for (const [name, user] of Object.entries(users)) {
    tokens[name] = authenticate(user);
  }
  return { tokens };
}

export default function (data) {
  const { PHASE, API, FROM, TO } = __ENV;
  const api = APIS[API];

  const res = http.post(
    `${BASE_URL}${api.path}`,
    JSON.stringify({ from_account: users[FROM].phone, to_account: users[TO].phone, amount: AMOUNT }),
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${data.tokens[FROM]}`,
        'X-AUTH-SECRET-KEY': SECRET,
      },
      tags: { api: API, phase: PHASE, name: API },
      responseCallback: http.expectedStatuses(201),
    },
  );

  let body = {};
  try {
    body = res.json();
  } catch (e) {
    body = {};
  }

  const passed = check(
    res,
    {
      'status is 201': (r) => r.status === 201,
      'transaction successful': (r) => r.status === 201 && !body.error,
      'transaction id returned': () => typeof body.trnxId === 'string' && body.trnxId.length > 0,
      'expected success message': () => body.message === api.message,
    },
    { api: API, phase: PHASE },
  );

  if (DEBUG && !passed) {
    console.error(`FAIL ${API} ${FROM}->${TO} status=${res.status} body=${res.body}`);
  }
}