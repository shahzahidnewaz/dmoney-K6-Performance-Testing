const http = require('http');
let n = 0;
http.createServer((req, res) => {
  let b = ''; req.on('data', c => (b += c));
  req.on('end', () => {
    const send = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    const delay = 5 + Math.random() * 40;
    setTimeout(() => {
      if (req.url.startsWith('/transaction/balance/')) return send(200, { message: 'User balance', balance: 0 });
      if (req.url === '/user/login') return send(200, { message: 'OTP sent', otpRequired: true });
      if (req.url.startsWith('/user/verify-otp')) return send(200, { message: 'Login successful', token: 'tok-' + (++n) });
      if (!req.headers.authorization || req.headers['x-auth-secret-key'] !== 'ROADTOSDET') return send(401, { message: 'No Token Found!' });
      const m = { '/transaction/deposit': 'Deposit successful', '/transaction/sendmoney': 'Send money successful', '/transaction/payment': 'Payment successful' }[req.url];
      if (m) return send(201, { message: m, trnxId: 'TXN' + Date.now() + (++n) });
      send(404, { message: 'nf' });
    }, delay);
  });
}).listen(5000, () => console.log('mock on 5000'));
