import http from 'k6/http';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:5000';
const SECRET = __ENV.PARTNER_KEY || 'ROADTOSDET';
const OTP = __ENV.OTP || '0000';
const SYSTEM_PASSWORD = __ENV.SYSTEM_PASSWORD || '1234';
const AGENT_TARGET = Number(__ENV.AGENT_BALANCE || 10000);
const CUSTOMER_TARGET = Number(__ENV.CUSTOMER_BALANCE || 3000);

const users = JSON.parse(open('./config/users.json'));

export const options = { vus: 1, iterations: 1 };

function authHeaders(token) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-AUTH-SECRET-KEY': SECRET };
}

function login(phone, password, needsOtp) {
  const headers = { 'Content-Type': 'application/json' };
  const res = http.post(`${BASE_URL}/user/login`, JSON.stringify({ phone_number: phone, password }), { headers });
  if (res.status !== 200) throw new Error(`login failed for ${phone}: ${res.status} ${res.body}`);
  if (!needsOtp) return res.json('token');
  const verify = http.post(
    `${BASE_URL}/user/verify-otp?env=dev`,
    JSON.stringify({ identifier: phone, otp: OTP }),
    { headers },
  );
  if (verify.status !== 200) throw new Error(`OTP failed for ${phone}: ${verify.status} ${verify.body}`);
  return verify.json('token');
}

function balance(token, phone) {
  const res = http.get(`${BASE_URL}/transaction/balance/${phone}`, { headers: authHeaders(token) });
  if (res.status !== 200) throw new Error(`balance lookup failed for ${phone}: ${res.status} ${res.body}`);
  return Number(res.json('balance'));
}

function send(token, path, from, to, amount) {
  const res = http.post(
    `${BASE_URL}${path}`,
    JSON.stringify({ from_account: from, to_account: to, amount }),
    { headers: authHeaders(token) },
  );
  if (res.status !== 201) throw new Error(`${path} ${from}->${to} failed: ${res.status} ${res.body}`);
}

export default function () {
  const system = login('SYSTEM', SYSTEM_PASSWORD, false);
  const agent1 = login(users.agent1.phone, users.agent1.password, true);
  const agent2 = login(users.agent2.phone, users.agent2.password, true);

  for (const [agent, token] of [['agent1', agent1], ['agent2', agent2]]) {
    const need = AGENT_TARGET - balance(token, users[agent].phone);
    if (need >= 10) send(system, '/transaction/deposit', 'SYSTEM', users[agent].phone, need);
  }

  for (const name of ['customer1', 'customer2']) {
    const user = users[name];
    const token = login(user.phone, user.password, true);
    const current = balance(token, user.phone);
    if (current < CUSTOMER_TARGET - 10) {
      send(agent1, '/transaction/deposit', users.agent1.phone, user.phone, CUSTOMER_TARGET - current);
    } else if (current > CUSTOMER_TARGET + 30) {
      send(token, '/transaction/payment', user.phone, users.merchant1.phone, current - CUSTOMER_TARGET - 20);
    }
    console.log(`${name} balance is now about ${CUSTOMER_TARGET}`);
  }
}