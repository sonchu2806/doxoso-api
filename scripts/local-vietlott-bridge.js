/**
 * Bridge đồng bộ Vietlott + XSKT lên Supabase từ MÁY LOCAL (IP nhà / 4G điện thoại),
 * tránh Cloudflare chặn IP Railway.
 *
 * Chạy từ thư mục gốc doxoso-api (cùng chỗ .env):
 *   node scripts/local-vietlott-bridge.js
 * hoặc: npm run local-bridge
 *
 * Mở trình duyệt: http://127.0.0.1:3847/  (PC)
 * Cùng WiFi, điện thoại: http://<IP-LAN-máy>:3847/  (ví dụ http://192.168.1.10:3847/)
 *
 * Cần .env: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (hoặc ANON nếu RLS cho phép upsert).
 * Tùy chọn: LOCAL_BRIDGE_TOKEN — bắt buộc header x-bridge-token khi gọi API.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');

const rootDir = path.join(__dirname, '..');
process.chdir(rootDir);

const envPath = path.join(rootDir, '.env');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
}

const vs = require(path.join(rootDir, 'vietlott-scrape'));
const {
  VIETLOTT_PRODUCT_IDS,
  scrapeVietlott,
  scrapeAllXSKT,
  saveXSKTToSupabase,
  normalizeDrawDateForSupabase,
} = vs;

const PORT = Math.max(1024, Math.min(65535, parseInt(process.env.LOCAL_BRIDGE_PORT || '3847', 10)));
const HOST = process.env.LOCAL_BRIDGE_HOST || '0.0.0.0';
const BRIDGE_TOKEN = String(process.env.LOCAL_BRIDGE_TOKEN || '').trim();

function bridgeAuth(req, res, next) {
  if (!BRIDGE_TOKEN) return next();
  const h = String(req.headers['x-bridge-token'] || req.headers.authorization || '').trim();
  const bearer = h.startsWith('Bearer ') ? h.slice(7).trim() : h;
  if (bearer !== BRIDGE_TOKEN) {
    return res.status(401).json({ success: false, error: 'Sai hoặc thiếu x-bridge-token (đặt LOCAL_BRIDGE_TOKEN trong .env).' });
  }
  next();
}

async function syncVietlottAll() {
  const results = {};
  for (const product of VIETLOTT_PRODUCT_IDS) {
    try {
      await scrapeVietlott(product, null, { forceNetwork: true });
      results[product] = { ok: true };
    } catch (e) {
      results[product] = { ok: false, error: e.message };
    }
  }
  return results;
}

async function syncXsktThreeRegions() {
  const out = { regions: {} };
  for (const region of ['mb', 'mt', 'mn']) {
    try {
      const all = await scrapeAllXSKT(null, region);
      let n = 0;
      for (const [dai, row] of Object.entries(all)) {
        const drawDateNorm = normalizeDrawDateForSupabase(row.drawDate);
        await saveXSKTToSupabase(dai, drawDateNorm, row);
        n++;
      }
      out.regions[region] = { ok: true, daiCount: n };
    } catch (e) {
      out.regions[region] = { ok: false, error: e.message };
    }
  }
  return out;
}

const app = express();
app.use(express.json({ limit: '2mb' }));

const staticDir = path.join(__dirname, 'local-bridge-static');

app.get('/api/health', (_req, res) => {
  const hasSb = !!(process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY));
  res.json({
    success: true,
    role: 'local-bridge',
    supabaseConfigured: hasSb,
    authRequired: !!BRIDGE_TOKEN,
    hint: 'Scrape chạy trên máy này (IP của bạn), rồi ghi Supabase.',
  });
});

app.post('/api/sync/vietlott', bridgeAuth, async (_req, res) => {
  try {
    const results = await syncVietlottAll();
    res.json({ success: true, results });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/sync/xskt', bridgeAuth, async (_req, res) => {
  try {
    const results = await syncXsktThreeRegions();
    res.json({ success: true, results });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/sync/full', bridgeAuth, async (_req, res) => {
  try {
    const vietlott = await syncVietlottAll();
    const xskt = await syncXsktThreeRegions();
    res.json({ success: true, vietlott, xskt });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.use(express.static(staticDir));

app.listen(PORT, HOST, () => {
  console.log('[local-bridge] Mở trình duyệt: http://127.0.0.1:' + PORT + '/');
  console.log('[local-bridge] Cùng WiFi — thay bằng IP LAN máy này (ipconfig / ifconfig).');
  if (BRIDGE_TOKEN) console.log('[local-bridge] Đã bật LOCAL_BRIDGE_TOKEN — nhập token trên trang web.');
  if (!process.env.SUPABASE_URL) console.warn('[local-bridge] Cảnh báo: chưa thấy SUPABASE_URL trong .env');
});
