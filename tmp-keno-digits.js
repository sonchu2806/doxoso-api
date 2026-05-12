const axios = require('axios');

(async () => {
  const { data } = await axios.get('https://vietlott.vn/vi/trung-thuong/ket-qua-trung-thuong/keno', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120' },
    timeout: 20000,
  });
  const s = String(data);
  const ids = [...s.matchAll(/\b(0\d{6,7})\b/g)].map((m) => m[1]);
  const uniq = [...new Set(ids)].slice(0, 30);
  console.log('sample 7-digit-like', uniq);
  const href = s.match(/view-detail-keno-result[^"']*id=(\d+)/i);
  console.log('href', href);
})();
