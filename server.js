const express = require('express');
const path = require('path');
const cors = require('cors');
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


const vs = require('./vietlott-scrape');
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
} = vs;

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

async function scrapeXSKT(dai, dateStr, region) {
  const preferredRegion = region || detectRegionByDai(dai);
  const drawDateKey = dateStr || toViDate(new Date());

  const sbCached = await getXSKTFromSupabase(dai, drawDateKey);
  if (sbCached) return sbCached;
  if (isMienBacDaiQuery(dai)) {
    const mbCached = await getXSKTFromSupabase(XSKT_MIEN_BAC_LABEL, drawDateKey);
    if (mbCached) return mbCached;
  }

  let allResults = await scrapeAllXSKT(dateStr, preferredRegion);
  const keys = Object.keys(allResults);

  if (allResults[XSKT_MIEN_BAC_LABEL] && isMienBacDaiQuery(dai)) {
    const data = allResults[XSKT_MIEN_BAC_LABEL];
    await saveXSKTToSupabase(XSKT_MIEN_BAC_LABEL, data.drawDate || drawDateKey, data);
    return data;
  }

  function norm(s) {
    return s.toLowerCase()
      .replace('tp. hồ chí minh', 'tp. hcm')
      .replace('hồ chí minh', 'hcm')
      .replace(/\s+/g, ' ').trim();
  }

  async function finishAndSave(data) {
    await saveXSKTToSupabase(dai, data.drawDate || drawDateKey, data);
    return data;
  }

  const normDai = norm(dai);
  if (allResults[dai]) return await finishAndSave(allResults[dai]);
  let found = keys.find(k => norm(k) === normDai || norm(k).includes(normDai) || normDai.includes(norm(k)));
  if (found) return await finishAndSave(allResults[found]);

  // Fallback: thử các miền còn lại nếu không match ở miền ưu tiên
  for (const r of ['mb', 'mt', 'mn']) {
    if (r === preferredRegion) continue;
    allResults = await scrapeAllXSKT(dateStr, r);
    if (allResults[XSKT_MIEN_BAC_LABEL] && isMienBacDaiQuery(dai)) {
      const data = allResults[XSKT_MIEN_BAC_LABEL];
      await saveXSKTToSupabase(XSKT_MIEN_BAC_LABEL, data.drawDate || drawDateKey, data);
      return data;
    }
    const otherKeys = Object.keys(allResults);
    if (allResults[dai]) return await finishAndSave(allResults[dai]);
    found = otherKeys.find(k => norm(k) === normDai || norm(k).includes(normDai) || normDai.includes(norm(k)));
    if (found) return await finishAndSave(allResults[found]);
  }

  console.warn('[XSKT] Không tìm thấy:', dai, '| Có:', keys);
  throw new Error('Đài ' + dai + ' chưa có kết quả hôm nay');
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
  try {
    const result = await scrapeXSKT(dai, date, region);
    res.json({ success: true, data: result });
  } catch(e) {
    console.error('XSKT error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/** Đếm dòng + vài mẫu để biết dữ liệu đã vào Supabase chưa (cần env + quyền SELECT trên bảng). */
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
 * Backfill Vietlott ~months tháng gần đây vào Supabase (mặc định 2).
 * Keno: giới hạn VIETLOTT_BACKFILL_KENO_MAX (mặc định 6000 kỳ lùi) vì mật độ kỳ cao.
 * ?sync=1 — chạy xong mới trả JSON (lâu, dễ timeout trên Railway).
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
    mode: 'background',
    products: productList,
    message:
      'Đang backfill nền (có thể 10–60+ phút). Theo dõi log Railway và GET /admin/supabase-status. Thử ?sync=1 khi chạy local.',
  });
});

app.get('/admin/scrape-all', async (req, res) => {
  const results = {};
  for (const product of VIETLOTT_PRODUCT_IDS) {
    try {
      const result = await scrapeVietlott(product, null);
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

    const limit = product === 'keno' ? 200 : product === 'lotto535' ? 180 : 90;

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