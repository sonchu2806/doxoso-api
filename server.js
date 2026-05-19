require('dotenv').config();

const express = require('express');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const cron = require('node-cron');
const axios = require('axios');
const cheerio = require('cheerio');
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase =
  supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;


const app = express();
app.use(cors());
app.use(express.json());
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';


const scanTicket = require('./scan-ticket');
const vs = require('./vietlott-scrape');

const scanUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Math.max(500000, parseInt(process.env.SCAN_VISION_MAX_IMAGE_BYTES || '1500000', 10)),
  },
});

function clientIpFromReq(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || req.socket?.remoteAddress || '';
}
const {
  VIETLOTT_PRODUCT_IDS,
  DRAW_DAYS,
  toViDate,
  detectRegionByDai,
  scrapeVietlott,
  scrapeAllXSKT,
  saveVietlottToSupabase,
  saveXSKTToSupabase,
  getVietlottFromSupabase,
  getXSKTFromSupabase,
  getVietlottKyListFromSupabase,
  getCurrentInfo,
  getUrlFromKySo,
  padVietlottId,
  buildVietlottDetailUrl,
  buildVietlottListingUrl,
  getCache,
  setCache,
  scrapeWithAxios,
  warmVietlottRecentToSupabase,
  backfillVietlottMonthsToSupabase,
  XSKT_MIEN_BAC_LABEL,
  isMienBacDaiQuery,
  normalizeDrawDateForSupabase,
  diagnoseVietlottConnectivity,
  forwardFillVietlottFromSupabase,
  resolveCanonicalXsktDai,
  findXsktDaiKeyInResults,
  xsktDaiLookupNames,
} = vs;

/** Query ?maxAhead= / ?forwardFillMax= — trần bước T+1… (mặc định env VIETLOTT_FORWARD_FILL_MAX hoặc 48, tối đa 500). */
function forwardFillOptsFromQuery(req) {
  const opts = {};
  const maxRaw = parseInt(String(req.query.maxAhead || req.query.forwardFillMax || ''), 10);
  const delayRaw = parseInt(String(req.query.delayMs || ''), 10);
  if (Number.isFinite(maxRaw) && maxRaw > 0) {
    opts.maxAhead = Math.min(500, maxRaw);
  }
  if (Number.isFinite(delayRaw) && delayRaw >= 0) {
    opts.delayMs = delayRaw;
  }
  return opts;
}

/** Kỳ theo lịch quay (khi Supabase mới có vài dòng — ví dụ Lotto 5/35). */
async function buildSyntheticKyList(product, limit) {
  const drawDays = DRAW_DAYS[product];
  if (!drawDays) return null;
  const info = await getCurrentInfo(product);
  if (!info || !info.currentKy) return null;
  const currentKyNum = parseInt(info.currentKy, 10);
  if (Number.isNaN(currentKyNum)) return null;
  const parts = String(info.currentDate || '').split('/');
  if (parts.length !== 3) return null;
  const current = new Date(parseInt(parts[2], 10), parseInt(parts[1], 10) - 1, parseInt(parts[0], 10));
  if (Number.isNaN(current.getTime())) return null;
  const DAY_NAMES = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
  const list = [];
  let kyNum = currentKyNum;
  for (let i = 0; i < limit; i++) {
    const d = String(current.getDate()).padStart(2, '0');
    const m2 = String(current.getMonth() + 1).padStart(2, '0');
    const y2 = current.getFullYear();
    list.push({
      kyso: padVietlottId(product, String(kyNum)),
      date: d + '/' + m2 + '/' + y2,
      drawDay: DAY_NAMES[current.getDay()],
    });
    kyNum--;
    do {
      current.setDate(current.getDate() - 1);
    } while (!drawDays.includes(current.getDay()));
  }
  return list;
}

async function scrapeXSKT(dai, dateStr, region, opts) {
  opts = opts || {};
  const canonicalDai = resolveCanonicalXsktDai(dai);
  const preferredRegion = region || detectRegionByDai(canonicalDai);
  const drawDateKey = dateStr || toViDate(new Date());

  if (!opts.forceNetwork) {
    for (const name of xsktDaiLookupNames(canonicalDai)) {
      const sbCached = await getXSKTFromSupabase(name, drawDateKey);
      if (sbCached) return sbCached;
    }
    if (isMienBacDaiQuery(canonicalDai)) {
      const mbCached = await getXSKTFromSupabase(XSKT_MIEN_BAC_LABEL, drawDateKey);
      if (mbCached) return mbCached;
    }
  }

  let allResults = await scrapeAllXSKT(dateStr, preferredRegion);

  async function finishAndSave(data, scrapedKey) {
    const row = Object.assign({}, data, { dai: canonicalDai });
    await saveXSKTToSupabase(canonicalDai, drawDateKey, data);
    return row;
  }

  if (isMienBacDaiQuery(canonicalDai)) {
    const mbKey = findXsktDaiKeyInResults(allResults, XSKT_MIEN_BAC_LABEL);
    if (mbKey && allResults[mbKey]) return await finishAndSave(allResults[mbKey], mbKey);
  }

  let foundKey = findXsktDaiKeyInResults(allResults, canonicalDai);
  if (foundKey && allResults[foundKey]) return await finishAndSave(allResults[foundKey], foundKey);

  for (const r of ['mb', 'mt', 'mn']) {
    if (r === preferredRegion) continue;
    allResults = await scrapeAllXSKT(dateStr, r);
    if (isMienBacDaiQuery(canonicalDai)) {
      const mbKey = findXsktDaiKeyInResults(allResults, XSKT_MIEN_BAC_LABEL);
      if (mbKey && allResults[mbKey]) return await finishAndSave(allResults[mbKey], mbKey);
    }
    foundKey = findXsktDaiKeyInResults(allResults, canonicalDai);
    if (foundKey && allResults[foundKey]) return await finishAndSave(allResults[foundKey], foundKey);
  }

  console.warn('[XSKT] Không tìm thấy:', canonicalDai, '| Có:', Object.keys(allResults));
  throw new Error('Đài ' + canonicalDai + ' chưa có kết quả cho ngày đã chọn');
}

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.get('/test-connection', async (req, res) => {
  const urls = [
    buildVietlottListingUrl('lotto535') || 'https://vietlott.vn/vi/',
    'https://www.minhngoc.net.vn/',
    'https://xoso.com.vn/',
  ].filter(Boolean);

  const results = {};
  for (const url of urls) {
    try {
      const start = Date.now();
      const { status } = await axios.get(url, {
        timeout: 10000,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      results[url] = { ok: true, status, ms: Date.now() - start };
    } catch (e) {
      results[url] = { ok: false, error: e.message };
    }
  }
  res.json(results);
});

app.get('/debug-lotto535', async (req, res) => {
  try {
    const url = buildVietlottListingUrl('lotto535');
    if (!url) return res.json({ error: 'Không có URL vietlott cho lotto535' });
    const { data: html } = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 15000,
    });
    const $ = cheerio.load(html);

    const titleTts = [];
    $('div.title_tt').each((_, el) => {
      titleTts.push($(el).text().trim().slice(0, 60));
    });

    const ballLotto = [];
    $('span.ball_lotto').each((_, el) => {
      ballLotto.push({ text: $(el).text().trim(), cls: $(el).attr('class') });
    });

    res.json({
      htmlLen: html.length,
      titleTts,
      ballLottoCount: ballLotto.length,
      ballLotto: ballLotto.slice(0, 10),
    });
  } catch(e) {
    res.json({ error: e.message });
  }
});

app.get('/debug-resolved-url', async (req, res) => {
  try {
    const product = String(req.query.product || '').trim();
    const kyso = String(req.query.kyso || '').trim();
    if (!product) return res.status(400).json({ success: false, error: 'Thiếu product' });

    const supported = [...VIETLOTT_PRODUCT_IDS];
    if (!supported.includes(product)) {
      return res.status(400).json({ success: false, error: 'Product không hợp lệ', supported });
    }

    const currentInfo = await getCurrentInfo(product);
    let resolvedUrl = buildVietlottListingUrl(product) || '';
    if (kyso) {
      resolvedUrl = await getUrlFromKySo(product, kyso);
    } else {
      if (VIETLOTT_PRODUCT_IDS.includes(product) && currentInfo?.currentKy != null && String(currentInfo.currentKy).trim() !== '') {
        const id = padVietlottId(product, currentInfo.currentKy);
        const u = buildVietlottDetailUrl(product, id);
        if (u) resolvedUrl = u;
      }
    }

    res.json({
      success: true,
      product,
      kyso: kyso || null,
      currentInfo,
      resolvedUrl,
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/xskt/all', async (req, res) => {
  const { date, region } = req.query;
  try {
    const result = await scrapeAllXSKT(date, region);
    res.json({ success: true, data: result });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/xskt', async (req, res) => {
  const { dai, date, region } = req.query;
  if (!dai) return res.status(400).json({ success: false, error: 'Thiếu tham số dai' });
  const forceNetwork = req.query.refresh === '1' || req.query.force === '1';
  try {
    const result = await scrapeXSKT(dai, date, region, { forceNetwork });
    res.json({ success: true, data: result });
  } catch(e) {
    console.error('XSKT error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** Đếm dòng + vài mẫu để biết dữ liệu đã vào Supabase chưa (cần env + quyền SELECT trên bảng). */
/** Đọc vé từ ảnh: Tesseract OCR trước, Claude Vision fallback. multipart `image`, channel=auto|xskt|vietlott */
app.post('/api/scan-ticket', scanUpload.single('image'), async (req, res) => {
  const channel = String(req.body?.channel || req.query?.channel || 'xskt')
    .toLowerCase()
    .trim();
  const ch =
    channel === 'vietlott' ? 'vietlott' : channel === 'auto' ? 'auto' : 'xskt';
  if (!req.file || !req.file.buffer) {
    return res.status(400).json({ success: false, error: 'Thiếu file ảnh (field name: image).' });
  }
  try {
    const out = await scanTicket.scanTicketFromImage(req.file.buffer, ch, {
      clientIp: clientIpFromReq(req),
      userAgent: String(req.headers['user-agent'] || '').slice(0, 200),
    });
    if (!out.success) {
      return res.status(out.status || 500).json(out);
    }
    return res.json(out);
  } catch (e) {
    console.error('[api/scan-ticket]', e.message);
    return res.status(500).json({ success: false, error: e.message });
  }
});

/** Thống kê lượt scan / token (bộ nhớ server — reset khi restart). */
app.get('/admin/scan-usage', (_req, res) => {
  res.json({ success: true, scan: scanTicket.getScanConfig(), ...scanTicket.getUsageStats() });
});

app.get('/admin/supabase-status', async (req, res) => {
  if (!supabase) {
    return res.json({
      success: true,
      supabaseConfigured: false,
      message: 'Chưa cấu hình SUPABASE_URL / SUPABASE_ANON_KEY trên server.',
    });
  }
  const tables = {};
  const vlCount = await supabase.from('vietlott_results').select('*', { count: 'exact', head: true });
  tables.vietlott_results = {
    count: vlCount.count,
    error: vlCount.error ? vlCount.error.message : null,
  };
  const xsCount = await supabase.from('xskt_results').select('*', { count: 'exact', head: true });
  tables.xskt_results = {
    count: xsCount.count,
    error: xsCount.error ? xsCount.error.message : null,
  };
  const vlSample = await supabase
    .from('vietlott_results')
    .select('product, kyso, draw_date')
    .order('product', { ascending: true })
    .order('kyso', { ascending: false })
    .limit(18);
  const xsSample = await supabase.from('xskt_results').select('dai, draw_date').limit(12);
  res.json({
    success: true,
    supabaseConfigured: true,
    tables,
    sampleVietlott: vlSample.error ? { error: vlSample.error.message } : vlSample.data || [],
    sampleXskt: xsSample.error ? { error: xsSample.error.message } : xsSample.data || [],
  });
});

/**
 * Chẩn đoán chặn Vietlott: gọi trang listing từ chính IP server (giống warm/scrape).
 * ?product=mega|power|keno|...
 * Xem probes[].status (403), cfRay, hints, bodySnippet.
 */
app.get('/admin/vietlott-connectivity', async (req, res) => {
  const product = String(req.query.product || 'mega')
    .toLowerCase()
    .trim();
  try {
    const report = await diagnoseVietlottConnectivity(product);
    res.json(Object.assign({ success: true }, report));
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * Backfill Vietlott ~months tháng gần đây vào Supabase (mặc định 2).
 * Keno: giới hạn VIETLOTT_BACKFILL_KENO_MAX (mặc định 6000 kỳ lùi) vì mật độ kỳ cao.
 * ?days=15 — cửa sổ ngày (ưu tiên hơn months cho độ sâu lùi kỳ).
 * ?keno=0 — bỏ qua Keno.
 * ?products=mega,power — chỉ các game liệt kê.
 */
app.get('/admin/backfill-vietlott', async (req, res) => {
  if (!supabase) {
    return res.status(400).json({
      success: false,
      error: 'Chưa cấu hình SUPABASE_URL / SUPABASE_ANON_KEY.',
    });
  }
  const months = Math.min(6, Math.max(1, parseInt(String(req.query.months || '2'), 10)));
  const sync = req.query.sync === '1' || req.query.wait === '1';
  const includeKeno = req.query.keno !== '0' && req.query.skipKeno !== '1';
  let productList = [...VIETLOTT_PRODUCT_IDS];
  const only = String(req.query.products || '').trim();
  if (only) {
    productList = only
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((p) => VIETLOTT_PRODUCT_IDS.includes(p));
    if (productList.length === 0) {
      return res.status(400).json({ success: false, error: 'products không hợp lệ' });
    }
  }
  if (!includeKeno) productList = productList.filter((p) => p !== 'keno');
  if (productList.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'Không còn sản phẩm sau khi lọc (thử bỏ keno=0 hoặc thêm products).',
    });
  }

  const opts = { products: productList };
  const daysParam = parseInt(String(req.query.days || ''), 10);
  if (Number.isFinite(daysParam) && daysParam > 0) {
    opts.days = Math.min(120, daysParam);
  }

  if (sync) {
    try {
      const stats = await backfillVietlottMonthsToSupabase(months, opts);
      return res.json({ success: true, months, mode: 'sync', stats });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  backfillVietlottMonthsToSupabase(months, opts)
    .then((stats) => console.log('[backfill vietlott] xong', JSON.stringify(stats)))
    .catch((e) => console.error('[backfill vietlott]', e));

  return res.json({
    success: true,
    months,
    days: opts.days != null ? opts.days : null,
    mode: 'background',
    products: productList,
    message:
      'Đang backfill nền (có thể 10–60+ phút). Theo dõi log Railway và GET /admin/supabase-status. Thử ?sync=1 khi chạy local. Ví dụ Lotto 15 ngày: ?products=lotto535&days=15',
  });
});

/**
 * Đồng bộ “hôm nay” giống `node sync.js --today`: mỗi Vietlott kỳ hiện tại + XSKT mb/mt/mn.
 * Mặc định chạy nền (trả JSON ngay, không chờ — tránh timeout WebView).
 * ?wait=1 — chờ xong rồi trả JSON (có thể 1–5+ phút, dễ timeout proxy).
 */
app.get('/admin/sync-today', async (req, res) => {
  const wait = req.query.wait === '1' || req.query.sync === '1';

  const ffOpts = forwardFillOptsFromQuery(req);

  async function job() {
    for (const product of VIETLOTT_PRODUCT_IDS) {
      try {
        await scrapeVietlott(product, null, {
          forceNetwork: true,
          forwardFillFromSupabase: true,
          forwardFill: ffOpts,
        });
        console.log('[admin/sync-today] vietlott ok', product);
      } catch (e) {
        console.warn('[admin/sync-today] vietlott', product, e.message);
      }
    }
    for (const region of ['mb', 'mt', 'mn']) {
      try {
        const slug = vs.resolveXsktScrapeDateSlug(null, region);
        const all = await scrapeAllXSKT(slug, region);
        for (const [dai, row] of Object.entries(all)) {
          const drawDateNorm = normalizeDrawDateForSupabase(row.drawDate || slug);
          await saveXSKTToSupabase(dai, drawDateNorm, row);
        }
        console.log('[admin/sync-today] xskt', region, Object.keys(all).length, 'đài');
      } catch (e) {
        console.warn('[admin/sync-today] xskt', region, e.message);
      }
    }
    console.log('[admin/sync-today] hoàn tất');
  }

  if (wait) {
    try {
      await job();
      return res.json({
        success: true,
        mode: 'wait',
        message: 'Đã đồng bộ Vietlott (kỳ hiện tại) + XSKT 3 miền vào Supabase.',
      });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  setImmediate(function () {
    job().catch(function (e) {
      console.error('[admin/sync-today] job', e);
    });
  });

  return res.json({
    success: true,
    mode: 'background',
    message:
      'Đã khởi chạy đồng bộ trên server (Vietlott + XSKT 3 miền). Vài phút sau mở “Supabase status” hoặc xem log Railway. Máy tính/điện thoại của bạn không cần bật sau khi đã nhận phản hồi này.',
    forwardFill: Object.keys(ffOpts).length ? ffOpts : null,
  });
});

/**
 * Forward-fill: từ kỳ lớn nhất đã có đủ số trong Supabase, dò T+1, T+2… qua trang chi tiết.
 * ?product=keno (mặc định) hoặc ?products=keno,mega — ?maxAhead=120 (mặc định 48 / env VIETLOTT_FORWARD_FILL_MAX).
 * ?wait=1 — chờ xong (Keno 120 kỳ có thể ~1–2 phút).
 */
app.get('/admin/forward-fill-vietlott', async (req, res) => {
  if (!supabase) {
    return res.status(400).json({
      success: false,
      error: 'Chưa cấu hình SUPABASE_URL / SUPABASE_ANON_KEY.',
    });
  }
  const wait = req.query.wait === '1' || req.query.sync === '1';
  const ffOpts = forwardFillOptsFromQuery(req);
  const envDefault = parseInt(process.env.VIETLOTT_FORWARD_FILL_MAX || '48', 10);
  const maxAheadUsed =
    ffOpts.maxAhead ||
    (Number.isFinite(envDefault) && envDefault > 0 ? Math.min(500, envDefault) : 48);

  let productList = ['keno'];
  const only = String(req.query.products || req.query.product || 'keno').trim();
  if (only && only.toLowerCase() !== 'all') {
    productList = only
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((p) => VIETLOTT_PRODUCT_IDS.includes(p));
    if (productList.length === 0) {
      return res.status(400).json({ success: false, error: 'product/products không hợp lệ' });
    }
  } else if (only.toLowerCase() === 'all') {
    productList = [...VIETLOTT_PRODUCT_IDS];
  }

  async function runFill() {
    const summaries = {};
    for (const product of productList) {
      try {
        summaries[product] = await forwardFillVietlottFromSupabase(product, ffOpts);
      } catch (e) {
        summaries[product] = { product, error: e.message, fetched: [] };
      }
    }
    return summaries;
  }

  if (wait) {
    try {
      const summaries = await runFill();
      return res.json({
        success: true,
        mode: 'wait',
        maxAhead: maxAheadUsed,
        forwardFill: ffOpts,
        products: productList,
        summaries,
      });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  setImmediate(function () {
    runFill()
      .then(function (summaries) {
        console.log('[admin/forward-fill-vietlott] xong', JSON.stringify(summaries));
      })
      .catch(function (e) {
        console.error('[admin/forward-fill-vietlott]', e);
      });
  });

  return res.json({
    success: true,
    mode: 'background',
    maxAhead: maxAheadUsed,
    forwardFill: ffOpts,
    products: productList,
    message:
      'Đang forward-fill (T+1 từ kỳ lớn nhất trong Supabase). Nếu log “đạt trần maxAhead”, tăng ?maxAhead= hoặc biến VIETLOTT_FORWARD_FILL_MAX trên Railway.',
  });
});

/**
 * Warm Vietlott: từ kỳ hiện tại lùi dần, chỉ scrape kỳ nào trong Supabase còn thiếu số → upsert.
 * Keno quay dày: dùng VIETLOTT_KENO_WARM_BACK (mặc định 48) hoặc ?kenoMaxBack=96.
 * ?wait=1 — chờ xong (có thể vài–chục phút nếu kenoMaxBack lớn).
 */
app.get('/admin/warm-vietlott', async (req, res) => {
  if (!supabase) {
    return res.status(400).json({
      success: false,
      error: 'Chưa cấu hình SUPABASE_URL / SUPABASE_ANON_KEY.',
    });
  }
  const wait = req.query.wait === '1' || req.query.sync === '1';
  const depthRaw = parseInt(String(req.query.depth || ''), 10);
  const kenoRaw = parseInt(String(req.query.kenoMaxBack || ''), 10);
  const warmOpts = {};
  if (Number.isFinite(depthRaw) && depthRaw > 0) {
    warmOpts.depth = Math.min(40, depthRaw);
  }
  if (Number.isFinite(kenoRaw) && kenoRaw > 0) {
    warmOpts.kenoMaxBack = Math.min(200, kenoRaw);
  }

  const run = function () {
    return warmVietlottRecentToSupabase(warmOpts);
  };

  if (wait) {
    return run()
      .then(function () {
        return res.json({
          success: true,
          mode: 'wait',
          opts: warmOpts,
          message: 'Warm Vietlott đã chạy xong (Keno + các game khác).',
        });
      })
      .catch(function (e) {
        return res.status(500).json({ success: false, error: e.message });
      });
  }

  setImmediate(function () {
    run().catch(function (e) {
      console.error('[admin/warm-vietlott]', e);
    });
  });

  return res.json({
    success: true,
    mode: 'background',
    opts: warmOpts,
    message:
      'Đã khởi chạy warm Vietlott (điền kỳ thiếu vào Supabase). Keno: mặc định lùi ~48 kỳ; thêm ?kenoMaxBack=120 nếu DB lệch nhiều. Hoặc backfill: /admin/backfill-vietlott?products=keno&days=1',
  });
});

app.get('/admin/scrape-all', async (req, res) => {
  const results = {};
  for (const product of VIETLOTT_PRODUCT_IDS) {
    try {
      const result = await scrapeVietlott(product, null, {
        forceNetwork: true,
        forwardFillFromSupabase: true,
      });
      if (result?.kySo) {
        await saveVietlottToSupabase(product, result.kySo, result);
        results[product] = { ok: true, kySo: result.kySo };
      } else {
        results[product] = { ok: false, error: 'Không lấy được dữ liệu' };
      }
    } catch (e) {
      results[product] = { ok: false, error: e.message };
    }
  }
  try {
    const xskt = await scrapeAllXSKT(null);
    for (const [dai, data] of Object.entries(xskt)) {
      await saveXSKTToSupabase(dai, data.drawDate, data);
    }
    results['xskt'] = { ok: true, count: Object.keys(xskt).length };
  } catch (e) {
    results['xskt'] = { ok: false, error: e.message };
  }
  res.json({ success: true, results });
});

app.get('/vietlott/keno/by-kyso', async (req, res) => {
  const { kyso } = req.query;
  if (!kyso) return res.status(400).json({ success: false, error: 'Thiếu kyso' });
  try {
    const result = await scrapeVietlott('keno', kyso);
    res.json({ success: true, data: result });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/vietlott/:product/list', async (req, res) => {
  const product = req.params.product;
  const drawDays = DRAW_DAYS[product];
  if (!drawDays) return res.status(400).json({ success: false, error: 'Invalid product' });

  try {
    const listCacheKey = 'list_' + product;
    const cachedList = getCache(listCacheKey);
    if (cachedList) return res.json({ success: true, data: cachedList });

    const limit = product === 'keno' ? 300 : product === 'lotto535' ? 180 : 90;

    let list = await getVietlottKyListFromSupabase(product, limit);
    let source = null;

    if (list && list.length > 0) {
      list = list.slice(0, limit);
      source = 'supabase';
    } else {
      list = [];
      const live = await buildSyntheticKyList(product, limit);
      if (live && live.length) {
        list = live.slice(0, limit);
        source = 'vietlott_live';
      } else {
        try {
          const info = await getCurrentInfo(product);
          if (info && info.currentKy && info.currentDate) {
            const currentKyNum = parseInt(info.currentKy, 10);
            if (!Number.isNaN(currentKyNum)) {
              const [dd, mm, yyyy] = info.currentDate.split('/');
              let current = new Date(parseInt(yyyy, 10), parseInt(mm, 10) - 1, parseInt(dd, 10));
              if (!Number.isNaN(current.getTime())) {
                const DAY_NAMES = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
                let kyNum = currentKyNum;
                for (let i = 0; i < limit; i++) {
                  const d = String(current.getDate()).padStart(2, '0');
                  const m2 = String(current.getMonth() + 1).padStart(2, '0');
                  const y2 = current.getFullYear();
                  list.push({
                    kyso: padVietlottId(product, String(kyNum)),
                    date: d + '/' + m2 + '/' + y2,
                    drawDay: DAY_NAMES[current.getDay()],
                  });
                  kyNum--;
                  do {
                    current.setDate(current.getDate() - 1);
                  } while (!drawDays.includes(current.getDay()));
                }
                source = 'vietlott_live';
              }
            }
          }
        } catch (e) {
          console.warn('[vietlott list] calendar fallback failed', product, e.message);
        }
      }
    }

    if (source) console.log('[vietlott list]', product, 'source=', source, 'count=', list.length);
    setCache(listCacheKey, list);
    res.json({ success: true, data: list || [] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/vietlott/:product', async (req, res) => {
  const { kyso } = req.query;
  try {
    const result = await scrapeVietlott(req.params.product, kyso);
    res.json({ success: true, data: result });
  } catch(e) {
    console.error('Vietlott error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

cron.schedule('*/5 16-21 * * *', () => {
  VIETLOTT_PRODUCT_IDS.forEach((p) => scrapeVietlott(p, null).catch(() => {}));
});

cron.schedule('45 */2 * * *', () => {
  warmVietlottRecentToSupabase().catch((e) => console.warn('[warm vietlott cron]', e.message));
});

if (process.env.VIETLOTT_WARM_ON_BOOT !== '0') {
  const bootMs = Math.max(5000, parseInt(process.env.VIETLOTT_WARM_BOOT_DELAY_MS || '25000', 10));
  setTimeout(() => {
    warmVietlottRecentToSupabase().catch((e) => console.warn('[warm vietlott boot]', e.message));
  }, bootMs);
  if (supabase && process.env.VIETLOTT_BOOT_LOTTO535_DAYS !== '0') {
    const lottoBootDays = Math.min(
      120,
      Math.max(0, parseInt(process.env.VIETLOTT_BOOT_LOTTO535_DAYS || '15', 10) || 15)
    );
    if (lottoBootDays > 0) {
      const lottoMs = bootMs + 45000;
      setTimeout(() => {
        backfillVietlottMonthsToSupabase(1, { products: ['lotto535'], days: lottoBootDays })
          .then((s) => console.log('[boot lotto535 backfill] done', s.byProduct && s.byProduct.lotto535))
          .catch((e) => console.warn('[boot lotto535 backfill]', e.message));
      }, lottoMs);
    }
  }
}

app.get('/debug-vietlott-html', async (req, res) => {
  const product = String(req.query.product || 'mega');
  const kyso = String(req.query.kyso || '');
  try {
    const id = kyso ? padVietlottId(product, kyso) : null;
    const url = id ? buildVietlottDetailUrl(product, id) : buildVietlottListingUrl(product);
    const { data: html } = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'vi-VN,vi;q=0.9',
      },
      timeout: 20000,
    });
    const $ = cheerio.load(html);
    res.json({
      url,
      htmlLen: html.length,
      hasBongTron: $('span.bong_tron').length,
      hasDaysoketquav2: $('div.day_so_ket_qua_v2').length,
      hasDivMax3D: $('#divMax3D').length,
      bodySnippet: $('body').text().slice(0, 500).replace(/\s+/g, ' '),
      bongTronList: $('span.bong_tron')
        .map((_, el) => ({ text: $(el).text().trim(), cls: $(el).attr('class') }))
        .get(),
      daysoContent: $('div.day_so_ket_qua_v2').first().html()?.slice(0, 300) || '',
      kysoMatch: ($('body').text().match(/#\s*(\d+)/) || [])[0] || '',
      dateMatch: ($('body').text().match(/(\d{2}\/\d{2}\/\d{4})/) || [])[0] || '',
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

app.get('/debug-fetch-raw', async (req, res) => {
  const url = String(
    req.query.url ||
      'https://vietlott.vn/vi/trung-thuong/ket-qua-trung-thuong/645?id=01508&nocatche=1'
  );
  try {
    const { data, status } = await axios.get(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'vi-VN,vi;q=0.9',
      },
      timeout: 20000,
      validateStatus: () => true,
    });
    res.json({
      status,
      htmlLen: String(data).length,
      snippet: String(data).slice(0, 300),
    });
  } catch (e) {
    res.json({ error: e.message, code: e.code });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log('✅ Doxoso API server chạy tại http://localhost:' + PORT);
  console.log('✅ Mobile access: http://172.20.10.12:' + PORT);
});