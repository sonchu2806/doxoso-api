'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const supabaseUrl = process.env.SUPABASE_URL;
/** Ưu tiên service role cho job sync — anon thường bị RLS chặn INSERT/UPDATE. */
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase =
  supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

const VIETLOTT_PROXY = process.env.VIETLOTT_PROXY_URL || '';

const cache = {};
const CACHE_TTL = 5 * 60 * 1000;
const CURRENT_INFO_TTL = 30 * 60 * 1000; // 30 phút
function getCache(key) {
  const item = cache[key];
  if (!item) return null;
  if (Date.now() - item.timestamp > CACHE_TTL) { delete cache[key]; return null; }
  return item.data;
}
function setCache(key, data) {
  cache[key] = { data, timestamp: Date.now() };
}
function toViDate(d) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return dd + '/' + mm + '/' + yyyy;
}
function toSlugDate(d) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return dd + '-' + mm + '-' + yyyy;
}

/** Chuẩn hóa ngày lưu Supabase: luôn dd/mm/yyyy; ISO yyyy-mm-dd → dd/mm/yyyy; Date → toViDate. */
function normalizeDrawDateForSupabase(s) {
  if (s == null || s === '') return '';
  if (s instanceof Date && !Number.isNaN(s.getTime())) {
    return toViDate(s);
  }
  const t = String(s).trim();
  const isoHead = t.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoHead) {
    const d = isoHead[1];
    const parts = d.split('-');
    return parts[2] + '/' + parts[1] + '/' + parts[0];
  }
  const vi = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (vi) {
    return vi[1].padStart(2, '0') + '/' + vi[2].padStart(2, '0') + '/' + vi[3];
  }
  return t;
}

/** Đọc từ DB: trả dd/mm/yyyy (hỗ trợ legacy yyyy-mm-dd trong DB). */
function drawDateFromPg(s) {
  if (s == null || s === '') return '';
  const t = String(s).trim();
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[3] + '/' + iso[2] + '/' + iso[1];
  const vi = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (vi) return vi[1].padStart(2, '0') + '/' + vi[2].padStart(2, '0') + '/' + vi[3];
  return t;
}

/** Vietlott — chỉ dùng vietlott.vn; URL/slug ketquadientoan đã gỡ (khôi phục từ git nếu cần). */

/** Chỉ các game Vietlott */
const VIETLOTT_PRODUCT_IDS = ['mega', 'power', 'max3d', 'max3dpro', 'lotto535', 'keno'];

const DRAW_DAYS = {
  mega:     [0, 3, 5],
  power:    [2, 4, 6],
  max3d:    [1, 3, 5],
  max3dpro: [2, 4, 6],
  lotto535: [0,1,2,3,4,5,6],
  keno:     [0,1,2,3,4,5,6],
};

/** Trang chi tiết kỳ trên vietlott.vn (theo id kỳ). */
const VIETLOTT_DETAIL_PATHS = {
  mega:     '/vi/trung-thuong/ket-qua-trung-thuong/645',
  power:    '/vi/trung-thuong/ket-qua-trung-thuong/655',
  max3d:    '/vi/trung-thuong/ket-qua-trung-thuong/max-3D',
  max3dpro: '/vi/trung-thuong/ket-qua-trung-thuong/max-3DPro',
  lotto535: '/vi/trung-thuong/ket-qua-trung-thuong/535',
  keno:     '/vi/trung-thuong/ket-qua-trung-thuong/view-detail-keno-result',
};

function padVietlottId(product, raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  const n = parseInt(digits, 10);
  if (Number.isNaN(n)) return '';
  if (product === 'keno') return String(n).padStart(7, '0');
  return String(n).padStart(5, '0');
}

function buildVietlottDetailUrl(product, id) {
  if (!VIETLOTT_PRODUCT_IDS.includes(product)) return null;
  const path = VIETLOTT_DETAIL_PATHS[product];
  if (!path || !id) return null;
  return 'https://vietlott.vn' + path + '?id=' + encodeURIComponent(String(id)) + '&nocatche=1';
}

/** Trang kết quả / danh sách trên vietlott (không gắn id kỳ). */
function buildVietlottListingUrl(product) {
  if (!VIETLOTT_PRODUCT_IDS.includes(product)) return null;
  if (product === 'keno') {
    return 'https://vietlott.vn/vi/trung-thuong/ket-qua-trung-thuong/winning-number-keno';
  }
  const path = VIETLOTT_DETAIL_PATHS[product];
  if (!path) return null;
  return 'https://vietlott.vn' + path;
}

const PRIZE_LABELS = {
  G1: 'Đặc biệt', G2: 'Giải nhất', G3: 'Giải nhì',
  G4: 'Giải ba', G5: 'Giải tư', G6: 'Giải năm',
};

const MAX_CONCURRENT = 2; // Tối đa 2 browser cùng lúc
let activeBrowsers = 0;

async function withBrowser(fn) {
  while (activeBrowsers >= MAX_CONCURRENT) {
    await new Promise((r) => setTimeout(r, 500));
  }

  activeBrowsers++;

  const apiKey = process.env.BROWSERLESS_API_KEY;
  let browser;
  if (apiKey) {
    browser = await puppeteer.connect({
      browserWSEndpoint: `wss://chrome.browserless.io?token=${encodeURIComponent(apiKey)}`,
    });
  } else {
    const baseArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--ignore-certificate-errors',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-gpu-sandbox',
      '--no-first-run',
      '--disable-extensions',
    ];
    if (process.env.PUPPETEER_USE_SINGLE_PROCESS === '1') {
      baseArgs.push('--no-zygote', '--single-process');
    }
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: baseArgs,
    });
  }

  const sessionMs = Math.max(
    90000,
    parseInt(process.env.PUPPETEER_SESSION_TIMEOUT_MS || '120000', 10)
  );
  const timeout = setTimeout(() => {
    console.warn('[withBrowser] Timeout — force closing browser sau', sessionMs, 'ms');
    browser.close().catch(() => {});
  }, sessionMs);

  try {
    return await fn(browser);
  } finally {
    clearTimeout(timeout);
    activeBrowsers--;
    browser.close().catch(() => {});
  }
}

/** Kỳ + ngày từ trang kết quả vietlott.vn (thay luồng ketquadientoan đã tắt). */
async function getCurrentKyFromVietlottListing(product) {
  const listUrl = buildVietlottListingUrl(product);
  if (!listUrl) return { currentKy: '', currentDate: '' };
  try {
    const { data: html } = await axios.get(listUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'vi-VN,vi;q=0.9',
      },
      timeout: 20000,
    });
    const $ = cheerio.load(html);

    if (product === 'keno') {
      const link = $('a[href*="view-detail-keno-result?id="]').first();
      let currentKy = '';
      let currentDate = '';
      if (link.length) {
        const href = link.attr('href') || '';
        const idMatch = href.match(/[?&]id=(\d+)/i);
        if (idMatch) currentKy = idMatch[1];
        let nearText = '';
        let $n = link;
        for (let depth = 0; depth < 10; depth++) {
          $n = $n.parent();
          if (!$n.length) break;
          nearText += ' ' + ($n.text() || '');
          const dm = nearText.match(/(\d{2}\/\d{2}\/\d{4})/);
          if (dm) {
            currentDate = dm[0];
            break;
          }
        }
        if (!currentDate) {
          const blob =
            (link.text() || '') +
            ' ' +
            (link.nextAll().text() || '') +
            ' ' +
            ($('body').text() || '');
          const dm2 = blob.match(/(\d{2}\/\d{2}\/\d{4})/);
          if (dm2) currentDate = dm2[0];
        }
      }
      return { currentKy, currentDate };
    }

    const blob =
      ($('#divLeftContent').text() || '') +
      ' ' +
      ($('.chitietketqua').first().text() || '') +
      ' ' +
      ($('body').text() || '');
    const kyMatch = blob.match(/#\s*(\d+)/);
    const dateMatch = blob.match(/(\d{2}\/\d{2}\/\d{4})/);
    return {
      currentKy: kyMatch ? kyMatch[1] : '',
      currentDate: dateMatch ? dateMatch[0] : '',
    };
  } catch (e) {
    console.warn('[getCurrentKyFromVietlottListing]', product, e.message);
    return { currentKy: '', currentDate: '' };
  }
}

// Lấy kỳ hiện tại + ngày (vietlott listing; ketquadientoan đã tắt)
async function getCurrentInfo(product) {
  const cacheKey = 'current_' + product;
  const cached = cache[cacheKey];
  if (cached && Date.now() - cached.timestamp < 60 * 60 * 1000) return cached.data;

  try {
    let currentKy = '';
    let currentDate = '';

    if (VIETLOTT_PRODUCT_IDS.includes(product)) {
      const fromVl = await getCurrentKyFromVietlottListing(product);
      currentKy = fromVl.currentKy || '';
      currentDate = fromVl.currentDate || '';
    }

    // ketquadientoan (getCurrentInfo): đã tắt — khôi phục từ git nếu cần.

    if (product === 'lotto535') {
      const now = new Date();
      const hour = now.getHours();
      // Nếu chưa đến 13h hôm nay → currentDate là hôm qua
      if (hour < 13) {
        const yesterday = new Date(now);
        yesterday.setDate(yesterday.getDate() - 1);
        const dd = String(yesterday.getDate()).padStart(2, '0');
        const mm = String(yesterday.getMonth() + 1).padStart(2, '0');
        const yyyy = yesterday.getFullYear();
        currentDate = dd + '/' + mm + '/' + yyyy;
      }
    }

    const info = { currentKy, currentDate };
    cache[cacheKey] = { data: info, timestamp: Date.now() };
    return info;
  } catch (e) {
    if (e.message.includes('timeout')) {
      // Tính kỳ hiện tại từ ngày hôm nay
      const today = new Date();
      const dd = String(today.getDate()).padStart(2, '0');
      const mm = String(today.getMonth() + 1).padStart(2, '0');
      const yyyy = today.getFullYear();
      return { currentKy: '', currentDate: dd + '/' + mm + '/' + yyyy };
    }
    console.warn('[getCurrentInfo ' + product + '] axios error:', e.message);
    return { currentKy: '', currentDate: '' };
  }
}

async function findDateUrlByKySo(_product, _kyso, _lookbackDays = 90) {
  // Tắt: quét trang theo ngày trên ketquadientoan (khôi phục từ git nếu cần).
  return null;
}

// Tính URL từ kyso
async function getUrlFromKySo(product, kyso) {
  if (!kyso) {
    if (VIETLOTT_PRODUCT_IDS.includes(product)) {
      return buildVietlottListingUrl(product) || '';
    }
    return '';
  }

  if (!VIETLOTT_PRODUCT_IDS.includes(product)) {
    return '';
  }

  if (product === 'max3d' || product === 'max3dpro' || product === 'mega' || product === 'power') {
    const info = await getCurrentInfo(product);
    const currentKyNum = parseInt(String(info?.currentKy).replace(/\D/g, ''), 10);
    const targetKyNum = parseInt(String(kyso).replace(/\D/g, ''), 10);

    if (!Number.isNaN(currentKyNum) && !Number.isNaN(targetKyNum) && targetKyNum > currentKyNum) {
      throw new Error(
        'Kỳ ' + kyso + ' vượt kỳ hiện tại #' + String(info.currentKy).padStart(5, '0') + ' của ' + product
      );
    }
    if (
      (product === 'max3d' || product === 'max3dpro') &&
      !Number.isNaN(currentKyNum) &&
      !Number.isNaN(targetKyNum)
    ) {
      const diffKy = currentKyNum - targetKyNum;
      if (diffKy > 90) {
        throw new Error(
          'Kỳ ' + kyso + ' quá cũ cho tra cứu nhanh của ' + product + ' (current #' + String(info.currentKy).padStart(5, '0') + ')'
        );
      }
    }
  }

  if (product === 'keno') {
    const info = await getCurrentInfo('keno');
    const cur = parseInt(String(info?.currentKy).replace(/\D/g, ''), 10);
    const target = parseInt(String(kyso).replace(/\D/g, ''), 10);
    if (!Number.isNaN(cur) && !Number.isNaN(target) && target > cur) {
      throw new Error(
        'Kỳ ' + kyso + ' vượt kỳ hiện tại #' + String(info.currentKy).padStart(7, '0') + ' của keno'
      );
    }
  }

  const idStr = padVietlottId(product, kyso);
  const url = buildVietlottDetailUrl(product, idStr);
  if (!url) throw new Error('Không tạo được URL Vietlott cho ' + product);
  console.log('[getUrlFromKySo vietlott] ' + product + ' kyso=' + kyso + ' -> ' + url);
  return url;
}

async function fetchHTML(url) {
  try {
    const { data } = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'vi-VN,vi;q=0.9',
      },
      timeout: 10000,
    });
    return data;
  } catch (e) {
    return null;
  }
}

function extractKyAndDateFromText(blob) {
  const text = String(blob || '').replace(/\s+/g, ' ');
  const kySo = (text.match(/#\s*(\d+)/) || [])[1] || '';
  const drawDate = (text.match(/(\d{2}\/\d{2}\/\d{4})/) || [])[1] || '';
  return { kySo, drawDate };
}

function parseOfficialMax3DFromVietlott($, isPro) {
  let wrap = $();
  let table = $();

  if (isPro) {
    wrap = $('#divMax3DProPlus');
    if (wrap.length) {
      table = wrap.find('table.table-hover').first();
    } else {
      const divsClass3dMax = $('div[class]')
        .filter((_, el) => /3d|max/i.test(String($(el).attr('class') || '')))
        .map((_, el) => $(el).attr('class'))
        .get();
      console.log('[max3dpro debug] divs class matching 3d|max:', divsClass3dMax);
      console.log(
        '[max3dpro debug] divs:',
        $('div[id], div[class*="3D"], div[class*="Max"]')
          .map((_, el) => $(el).attr('id') || $(el).attr('class'))
          .get()
          .slice(0, 20)
      );

      const altTable = $('.chitietketqua_table.Max3DPro_table').first();
      const altDivMax = $('div[class*="Max3DPro"]').first();
      const altDivLower = $('div[class*="max3dpro"]').first();

      if (altTable.length) {
        wrap = altTable;
        table = altTable.is('table') ? altTable : altTable.find('table.table-hover').first();
      } else if (altDivMax.length) {
        wrap = altDivMax;
        table = altDivMax.find('table.table-hover').first();
      } else if (altDivLower.length) {
        wrap = altDivLower;
        table = altDivLower.find('table.table-hover').first();
      }

      if (!table.length && wrap.length) {
        table = wrap.find('table').first();
      }
    }
  } else {
    wrap = $('#divMax3D');
    table = wrap.find('table.table-hover').first();
  }

  if (!table.length) return null;
  const sets = [];
  const seenRowSig = new Set();
  table.find('tbody tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 2) return;
    const labelText = tds.eq(0).text().replace(/\s+/g, ' ').trim().toLowerCase();
    let base = '';
    if (isPro) {
      if (labelText.includes('đặc biệt') && !labelText.includes('phụ')) base = 'Đặc biệt';
      else if (labelText.includes('phụ')) base = 'Giải phụ Đặc biệt';
      else if (labelText.includes('nhất')) base = 'Giải nhất';
      else if (labelText.includes('nhì')) base = 'Giải nhì';
      else if (labelText.includes('ba')) base = 'Giải ba';
      else return;
    } else {
      if (labelText.includes('đặc biệt')) base = 'Đặc biệt';
      else if (labelText.includes('nhất')) base = 'Giải nhất';
      else if (labelText.includes('nhì')) base = 'Giải nhì';
      else if (labelText.includes('ba')) base = 'Giải ba';
      else return;
    }
    const cell = tds.eq(1);
    const parts = [];
    const pushThreeDigitSpan = ($sp) => {
      const w = $sp.text().trim();
      if (/^\d{3}$/.test(w)) parts.push(w);
    };
    if (isPro) {
      cell.find('span.red').each((_, sp) => pushThreeDigitSpan($(sp)));
    } else {
      cell.find('span').each((_, sp) => {
        const cls = String($(sp).attr('class') || '').trim();
        if (cls.includes('red')) return;
        pushThreeDigitSpan($(sp));
      });
      if (parts.length === 0) {
        const raw = cell.text().replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
        const m = raw.match(/\d{3}/g);
        if (m) parts.push(...m);
      }
    }
    const rowSig = base + '|' + parts.slice().sort().join(',');
    if (seenRowSig.has(rowSig)) return;
    seenRowSig.add(rowSig);
    parts.forEach((w, idx) => {
      sets.push({ label: base + ' bộ ' + (idx + 1), numbers: w.split('').map((c) => parseInt(c, 10)) });
    });
  });
  if (sets.length === 0) return null;
  const blob = wrap.text() + ' ' + $('body').text();
  const { kySo, drawDate } = extractKyAndDateFromText(blob);
  return { sets, kySo, drawDate };
}

function parseOfficialMegaPowerL535FromVietlott($, product) {
  const left = $('#divLeftContent');
  const area = left.length ? left : $('body');
  const box = area.find('div.day_so_ket_qua_v2').first();
  if (!box.length) return null;

  const items = [];
  box.find('span.bong_tron').each((_, el) => {
    const $el = $(el);
    const t = parseInt($el.text().trim(), 10);
    if (Number.isNaN(t)) return;
    items.push({ val: t, cls: String($el.attr('class') || '') });
  });

  const blob = String($('body').text() || '').replace(/\s+/g, ' ');
  let { kySo, drawDate } = extractKyAndDateFromText(blob);

  if (product === 'mega') {
    if (items.length === 6) {
      return { numbers: items.map((x) => x.val), powerNumber: null, kySo, drawDate };
    }
    return null;
  }
  if (product === 'power') {
    let powerIdx = -1;
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].cls.includes('active')) {
        powerIdx = i;
        break;
      }
    }
    if (powerIdx === -1) return null;
    const powerNumber = items[powerIdx].val;
    const nums = items.filter((_, i) => i !== powerIdx).map((x) => x.val);
    if (nums.length === 6) {
      return { numbers: nums, powerNumber, kySo, drawDate };
    }
    return null;
  }
  if (product === 'lotto535') {
    let powerIdx = -1;
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].cls.includes('active')) {
        powerIdx = i;
        break;
      }
    }
    if (powerIdx === -1) return null;
    const powerNumber = items[powerIdx].val;
    const nums = items.filter((_, i) => i !== powerIdx).map((x) => x.val);
    if (nums.length === 5) {
      return { numbers: nums, powerNumber, kySo, drawDate };
    }
    return null;
  }
  return null;
}

function uniqueKenoNumsUpTo20(arr) {
  return [...new Set(arr)].slice(0, 20);
}

function parseOfficialKenoFromVietlott($, kysoTarget) {
  const nums = [];
  const kenoBox = $('#divKenoResultContent .day_so_ket_qua_v2').first();
  if (kenoBox.length) {
    kenoBox
      .find('span.bong_tron.small, span[class*="bong_tron"], span.ball_keno')
      .each((_, el) => {
        const n = parseInt($(el).text().trim(), 10);
        if (!Number.isNaN(n) && n >= 1 && n <= 80) nums.push(n);
      });
  } else {
    $('#divKenoResultContent')
      .find('span.bong_tron.small, span[class*="bong_tron"], span.ball_keno')
      .add('span.bong_tron.small')
      .each((_, el) => {
        const n = parseInt($(el).text().trim(), 10);
        if (!Number.isNaN(n) && n >= 1 && n <= 80) nums.push(n);
      });
  }

  let drawDate = '';
  let kySo = '';
  let metaRow = null;
  const rows = $('#divKenoResultContent table.table-result-info tbody tr, #divKenoResultContent table tbody tr');
  rows.each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 3) return;
    const t0 = tds.eq(0).text();
    const t1 = tds.eq(1).text();
    const dateMatch = t0.match(/(\d{2}\/\d{2}\/\d{4})/);
    if (!dateMatch) return;
    const kyFromHash = (t1.match(/#\s*(\d+)/) || [])[1];
    const kyLong = (t1.match(/(\d{6,})/) || [])[1];
    if (!kyFromHash && !kyLong) return;
    drawDate = dateMatch[1];
    kySo = kyFromHash || kyLong || '';
    metaRow = tr;
    return false;
  });
  if (!metaRow) {
    $('table tbody tr').each((_, tr) => {
      const tds = $(tr).find('td');
      if (tds.length < 3) return;
      const t0 = tds.eq(0).text();
      const t1 = tds.eq(1).text();
      const dateMatch = t0.match(/(\d{2}\/\d{2}\/\d{4})/);
      if (!dateMatch) return;
      const kyFromHash = (t1.match(/#\s*(\d+)/) || [])[1];
      const kyLong = (t1.match(/(\d{6,})/) || [])[1];
      if (!kyFromHash && !kyLong) return;
      drawDate = dateMatch[1];
      kySo = kyFromHash || kyLong || '';
      metaRow = tr;
      return false;
    });
  }

  if (uniqueKenoNumsUpTo20(nums).length < 10 && metaRow) {
    const tds = $(metaRow).find('td');
    const cellForNums = tds.length >= 3 ? tds.eq(2) : $(metaRow);
    cellForNums.find('span.bong_tron.small, span.bong_tron').each((_, el) => {
      const n = parseInt($(el).text().trim(), 10);
      if (!Number.isNaN(n) && n >= 1 && n <= 80) nums.push(n);
    });
  }

  const unique = uniqueKenoNumsUpTo20(nums);
  if (unique.length < 10) return null;
  if (!kySo && kysoTarget) kySo = String(kysoTarget).replace(/\D/g, '');
  if (!drawDate || !kySo) {
    const { kySo: k2, drawDate: d2 } = extractKyAndDateFromText($('body').text());
    if (!kySo) kySo = k2;
    if (!drawDate) drawDate = d2;
  }
  return { numbers: unique, powerNumber: null, kySo, drawDate };
}

/** Keno kỳ hiện tại: đợi DOM + cheerio; nếu đang ở listing SPA thì thử theo link chi tiết. */
async function tryParseKenoCurrentFromPuppeteerPage(page) {
  const selectors =
    '#divKenoResultContent span.bong_tron.small, #divKenoResultContent span[class*="bong_tron"], span.bong_tron.small, span.ball_keno, #divKenoResultContent span.ball_keno';
  try {
    await page.waitForSelector(selectors, { timeout: 38000 });
  } catch (_e) {
    /* vẫn thử parse */
  }
  const fromHtml = (html) => parseOfficialKenoFromVietlott(cheerio.load(html), null);

  let html = await page.content();
  let parsed = fromHtml(html);
  if (parsed && Array.isArray(parsed.numbers) && parsed.numbers.length >= 10) return parsed;

  const detailHref = await page.evaluate(() => {
    const as = Array.from(document.querySelectorAll('a[href*="view-detail-keno-result"]'));
    for (const a of as) {
      const raw = a.getAttribute('href') || '';
      if (!raw.includes('view-detail-keno-result')) continue;
      try {
        return new URL(raw, window.location.origin).href;
      } catch (_e) {
        return raw.startsWith('http') ? raw : `${window.location.origin}${raw.startsWith('/') ? '' : '/'}${raw}`;
      }
    }
    return '';
  });
  let cur = '';
  try {
    cur = page.url();
  } catch (_e) {
    cur = '';
  }
  if (
    detailHref &&
    detailHref !== cur &&
    !String(cur).includes('view-detail-keno-result?id=')
  ) {
    try {
      await page.goto(detailHref, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await new Promise((r) => setTimeout(r, 2000));
      try {
        await page.waitForSelector(selectors, { timeout: 28000 });
      } catch (_e2) {
        /* ignore */
      }
      html = await page.content();
      parsed = fromHtml(html);
      if (parsed && Array.isArray(parsed.numbers) && parsed.numbers.length >= 10) return parsed;
    } catch (_e) {
      /* ignore */
    }
  }
  return null;
}

function parseVietlottOfficialHtml($, product, kysoTarget) {
  try {
    if (product === 'max3d') return parseOfficialMax3DFromVietlott($, false);
    if (product === 'max3dpro') return parseOfficialMax3DFromVietlott($, true);
    if (product === 'keno') return parseOfficialKenoFromVietlott($, kysoTarget);
    if (product === 'mega' || product === 'power' || product === 'lotto535') {
      return parseOfficialMegaPowerL535FromVietlott($, product);
    }
  } catch (e) {
    console.log('[parseVietlottOfficialHtml]', e.message);
  }
  return null;
}

async function scrapeWithAxios(url, product, kysoTarget) {
  try {
    const u = String(url);
    if (!u.includes('vietlott.vn')) return null;

    const fetchUrl =
      VIETLOTT_PROXY && u.includes('vietlott.vn')
        ? VIETLOTT_PROXY + '?url=' + encodeURIComponent(u)
        : u;
    const { data: html } = await axios.get(fetchUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'vi-VN,vi;q=0.9,en;q=0.8',
      },
      timeout: 20000,
    });
    const htmlStr = typeof html === 'string' ? html : String(html ?? '');
    console.log('[scrapeWithAxios] fetched url:', u, 'htmlLen:', htmlStr.length, 'hasProPlus:', htmlStr.includes('divMax3DProPlus'));

    const $ = cheerio.load(html);
    const offic = parseVietlottOfficialHtml($, product, kysoTarget);
    if (offic) return offic;
    if (['mega', 'power', 'max3d', 'max3dpro', 'lotto535', 'keno'].includes(product)) {
      console.log('[scrapeWithAxios] vietlott.vn parse failed', product);
    }
    return null;
  } catch(e) {
    console.log('[scrapeWithAxios] failed:', e.message, e.stack?.slice(0,200));
    return null;
  }
}

function parseVietlottByCheerio(_product, _html) {
  // Parser HTML kiểu ketquadientoan — đã tắt (khôi phục từ git nếu cần).
  return null;
}

// Lưu kết quả Vietlott vào Supabase (kyso luôn lưu dạng pad để tra cứu thống nhất)
async function saveVietlottToSupabase(product, kyso, data) {
  if (!supabase) return;
  const key = padVietlottId(product, kyso || data.kySo || '');
  if (!key) return;
  try {
    const { error } = await supabase.from('vietlott_results').upsert(
      {
        product,
        kyso: key,
        draw_date: normalizeDrawDateForSupabase(data.drawDate || ''),
        numbers: data.numbers || [],
        power_number: data.powerNumber || null,
        sets: data.sets || null,
      },
      { onConflict: 'product,kyso' }
    );
    if (error) {
      console.error('[supabase] vietlott upsert failed:', product, key, error.message);
      return;
    }
    console.log('[supabase] saved vietlott', product, key);
  } catch (e) {
    console.error('[supabase] save error:', e.message);
  }
}

// Lấy kết quả Vietlott từ Supabase (thử cả kyso gốc và bản pad)
async function getVietlottFromSupabase(product, kyso) {
  if (!supabase || !kyso) return null;
  const raw = String(kyso).trim();
  if (!raw) return null;
  const padded = padVietlottId(product, raw);
  const keysTry = padded && padded !== raw ? [padded, raw] : [padded || raw];
  const keys = [...new Set(keysTry.filter(Boolean))];
  for (const k of keys) {
    try {
      const { data, error } = await supabase
        .from('vietlott_results')
        .select('*')
        .eq('product', product)
        .eq('kyso', k)
        .limit(1)
        .maybeSingle();
      if (error || !data) continue;
      console.log('[supabase] cache hit', product, k);
      return {
        numbers: data.numbers,
        powerNumber: data.power_number,
        sets: data.sets,
        kySo: data.kyso,
        drawDate: drawDateFromPg(data.draw_date),
      };
    } catch (_e) {
      // thử khóa kỳ khác
    }
  }
  return null;
}

/** Số kỳ Keno lớn nhất đã lưu (để neo dò kỳ mới nhất khi không có kyso). */
async function getMaxKenoKyNumericFromSupabase() {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('vietlott_results')
      .select('kyso')
      .eq('product', 'keno')
      .order('kyso', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data?.kyso) return null;
    const n = parseInt(String(data.kyso).replace(/\D/g, ''), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch (_e) {
    return null;
  }
}

/** Một dòng Keno đầy đủ số, kỳ mới nhất trong DB (fallback khi không scrape được live). */
async function getLatestFullKenoFromSupabase() {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('vietlott_results')
      .select('*')
      .eq('product', 'keno')
      .order('kyso', { ascending: false })
      .limit(8);
    if (error || !Array.isArray(data)) return null;
    for (const row of data) {
      const nums = row.numbers;
      if (Array.isArray(nums) && nums.length >= 10) {
        return {
          numbers: nums,
          powerNumber: row.power_number,
          sets: row.sets,
          kySo: row.kyso,
          drawDate: drawDateFromPg(row.draw_date),
        };
      }
    }
    return null;
  } catch (_e) {
    return null;
  }
}

/** Kỳ mới nhất đã lưu theo product (order kyso desc). Chỉ trả khi có numbers hoặc sets. */
async function getLatestVietlottFromSupabase(product) {
  if (!supabase || !VIETLOTT_PRODUCT_IDS.includes(product)) return null;
  try {
    const { data, error } = await supabase
      .from('vietlott_results')
      .select('*')
      .eq('product', product)
      .order('kyso', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    const filled =
      (Array.isArray(data.numbers) && data.numbers.length > 0) ||
      (Array.isArray(data.sets) && data.sets.length > 0);
    if (!filled) return null;
    console.log('[supabase] latest vietlott row', product, data.kyso);
    return {
      numbers: data.numbers,
      powerNumber: data.power_number,
      sets: data.sets,
      kySo: data.kyso,
      drawDate: drawDateFromPg(data.draw_date),
    };
  } catch (_e) {
    return null;
  }
}

/**
 * Keno không kyso: dùng kỳ từ winning-number-keno (getCurrentInfo) + dò vài kỳ kế tiếp bằng axios.
 * Tránh probe hàng chục URL trước khi thử đúng trang chi tiết (gây load rất lâu).
 */
async function fetchKenoNoKysoViaDetailAxios(info, cacheKey) {
  const id0 =
    info?.currentKy != null && String(info.currentKy).trim() !== ''
      ? padVietlottId('keno', info.currentKy)
      : '';
  if (!id0) return null;
  const baseN = parseInt(String(id0).replace(/\D/g, ''), 10);
  if (!Number.isFinite(baseN) || baseN < 1) return null;

  const aheadMax = Math.max(0, Math.min(24, parseInt(process.env.VIETLOTT_KENO_FAST_AHEAD || '12', 10)));
  let best = null;
  let bestN = -1;

  for (let j = 0; j <= aheadMax; j++) {
    const idStr = padVietlottId('keno', baseN + j);
    const u = buildVietlottDetailUrl('keno', idStr);
    const r = await scrapeWithAxios(u, 'keno', idStr);
    if (!r || !Array.isArray(r.numbers) || r.numbers.length < 10) {
      if (j === 0) return null;
      break;
    }
    const kn = parseInt(padVietlottId('keno', r.kySo || idStr), 10);
    if (Number.isFinite(kn) && kn > bestN) {
      bestN = kn;
      best = r;
    }
  }

  if (!best) return null;
  const rowKy = padVietlottId('keno', best.kySo || '');
  if (rowKy) best.kySo = rowKy;
  setCache(cacheKey, best);
  await saveVietlottToSupabase('keno', rowKy || best.kySo, best);
  console.log('[keno] fetchKenoNoKysoViaDetailAxios kySo=' + best.kySo);
  return best;
}

/**
 * Keno không kyso: dò các trang chi tiết ?id= (axios) — chỉ fallback khi không lấy được kỳ từ listing / chi tiết nhanh.
 * Neo từ max(kỳ listing, max DB, VIETLOTT_KENO_PROBE_START), lấy kết quả có kỳ số lớn nhất trong cửa sổ.
 */
async function probeLatestKenoWithAxios(info) {
  const sbMax = await getMaxKenoKyNumericFromSupabase();
  const infoKy = parseInt(String(info?.currentKy || '').replace(/\D/g, ''), 10);
  const envStart = parseInt(process.env.VIETLOTT_KENO_PROBE_START || '0', 10);
  let base = Math.max(
    Number.isFinite(sbMax) ? sbMax : 0,
    Number.isFinite(infoKy) ? infoKy : 0,
    Number.isFinite(envStart) ? envStart : 0
  );
  if (base < 100000) base = 2800720;

  const range = Math.max(8, Math.min(120, parseInt(process.env.VIETLOTT_KENO_PROBE_RANGE || '28', 10)));
  let best = null;
  let bestN = -1;
  for (let i = -5; i < range; i++) {
    const n = base + i;
    if (n < 1) continue;
    const idStr = padVietlottId('keno', n);
    const u = buildVietlottDetailUrl('keno', idStr);
    const r = await scrapeWithAxios(u, 'keno', idStr);
    if (!r || !Array.isArray(r.numbers) || r.numbers.length < 10) continue;
    const kn = parseInt(padVietlottId('keno', r.kySo || idStr), 10);
    if (Number.isFinite(kn) && kn > bestN) {
      bestN = kn;
      best = r;
    }
  }
  // Kỳ mới có thể nằm ngay sau kỳ neo (DB chưa kịp cập nhật): dò thêm vài kỳ về phía sau.
  if (best && bestN > 0) {
    const ahead = Math.max(2, Math.min(20, parseInt(process.env.VIETLOTT_KENO_PROBE_AHEAD || '8', 10)));
    for (let j = 1; j <= ahead; j++) {
      const idStr = padVietlottId('keno', bestN + j);
      const r = await scrapeWithAxios(buildVietlottDetailUrl('keno', idStr), 'keno', idStr);
      if (!r || !Array.isArray(r.numbers) || r.numbers.length < 10) break;
      const kn = parseInt(padVietlottId('keno', r.kySo || idStr), 10);
      if (Number.isFinite(kn) && kn > bestN) {
        bestN = kn;
        best = r;
      }
    }
  }
  return best;
}

// Lưu kết quả XSKT vào Supabase
async function saveXSKTToSupabase(dai, drawDate, data) {
  if (!supabase) return;
  try {
    const viDate = normalizeDrawDateForSupabase(drawDate);
    const { error } = await supabase.from('xskt_results').upsert(
      {
        dai,
        draw_date: viDate,
        special_prize: data.specialPrize || '',
        prizes: data.prizes || [],
      },
      { onConflict: 'dai,draw_date' }
    );
    if (error) {
      console.error('[supabase] xskt upsert failed:', dai, drawDate, error.message);
      return;
    }
    console.log('[supabase] saved xskt', dai, drawDate);
  } catch (e) {
    console.error('[supabase] save xskt error:', e.message);
  }
}

// Lấy kết quả XSKT từ Supabase
async function getXSKTFromSupabase(dai, drawDate) {
  if (!supabase || !drawDate) return null;
  try {
    const keyDate = normalizeDrawDateForSupabase(drawDate);
    const { data, error } = await supabase
      .from('xskt_results')
      .select('*')
      .eq('dai', dai)
      .eq('draw_date', keyDate || drawDate)
      .single();
    if (error || !data) return null;
    console.log('[supabase] cache hit xskt', dai, drawDate);
    return {
      specialPrize: data.special_prize,
      prizes: data.prizes,
      drawDate: drawDateFromPg(data.draw_date),
    };
  } catch (e) {
    return null;
  }
}

async function scrapeVietlott(product, kyso) {
  if (!VIETLOTT_PRODUCT_IDS.includes(product)) {
    throw new Error('Sản phẩm không phải Vietlott hoặc không được hỗ trợ: ' + product);
  }

  const cacheKey = 'vl_' + product + (kyso ? '_' + kyso : '');
  const cached = getCache(cacheKey);
  if (cached) return cached;

  let info = null;
  if (!kyso) {
    info = await getCurrentInfo(product);
    const curId =
      info?.currentKy != null && String(info.currentKy).trim() !== ''
        ? padVietlottId(product, info.currentKy)
        : '';
    if (curId) {
      const sbData = await getVietlottFromSupabase(product, curId);
      if (sbData) {
        setCache(cacheKey, sbData);
        return sbData;
      }
    }
  } else {
    const sbData = await getVietlottFromSupabase(product, kyso);
    if (sbData) {
      setCache(cacheKey, sbData);
      return sbData;
    }
  }

  // Keno không kyso: trước tiên 1–13 request chi tiết theo kỳ từ winning-number-keno; probe rộng chỉ khi cần.
  if (product === 'keno' && !kyso) {
    const viaDetail = await fetchKenoNoKysoViaDetailAxios(info, cacheKey);
    if (viaDetail) return viaDetail;

    const probed = await probeLatestKenoWithAxios(info);
    if (probed) {
      const rowKy = padVietlottId('keno', probed.kySo || '');
      if (rowKy) probed.kySo = rowKy;
      setCache(cacheKey, probed);
      await saveVietlottToSupabase(product, rowKy || probed.kySo, probed);
      console.log('[keno] probeLatestKenoWithAxios kySo=' + probed.kySo);
      return probed;
    }
    const stale = await getLatestFullKenoFromSupabase();
    if (stale) {
      setCache(cacheKey, stale);
      console.log('[keno] fallback getLatestFullKenoFromSupabase kySo=' + stale.kySo);
      return stale;
    }
  }

  const tryUrls = [];

  if (kyso) {
    const u = await getUrlFromKySo(product, kyso);
    if (u) tryUrls.push(u);
  } else {
    const id =
      info?.currentKy != null && String(info.currentKy).trim() !== ''
        ? padVietlottId(product, info.currentKy)
        : '';
    const detailUrl = id ? buildVietlottDetailUrl(product, id) : null;
    const listUrl = buildVietlottListingUrl(product);
    // Max3D / Pro: ưu tiên trang listing (HTML ổn định, parse nhanh); detail để fallback.
    if (product === 'max3d' || product === 'max3dpro') {
      if (listUrl) tryUrls.push(listUrl);
      if (detailUrl) tryUrls.push(detailUrl);
    } else if (product === 'keno') {
      if (detailUrl) tryUrls.push(detailUrl);
      if (listUrl) tryUrls.push(listUrl);
    } else {
      if (detailUrl) tryUrls.push(detailUrl);
      if (listUrl && !tryUrls.includes(listUrl)) tryUrls.push(listUrl);
    }
  }

  if (tryUrls.length === 0) throw new Error('Unknown product: ' + product);

  let axiosResult = null;
  let url = tryUrls[0];
  for (const u of tryUrls) {
    if (!u) continue;
    const r = await scrapeWithAxios(u, product, kyso);
    if (r) {
      axiosResult = r;
      url = u;
      break;
    }
  }

  // Thử axios theo tryUrls (chỉ vietlott.vn; ketquadientoan đã tắt).
  if (axiosResult) {
    if ((product === 'max3d' || product === 'max3dpro') && kyso && !axiosResult.kySo) {
      axiosResult.kySo = kyso;
    }
    if ((product === 'max3d' || product === 'max3dpro') && !axiosResult.drawDate) {
      const m = url.match(/\/(\d{2})-(\d{2})-(\d{4})\.html/);
      if (m) axiosResult.drawDate = m[1] + '/' + m[2] + '/' + m[3];
      if (!axiosResult.drawDate && String(url).includes('vietlott.vn')) {
        axiosResult.drawDate = toViDate(new Date());
      }
    }
    const rowKy = padVietlottId(product, axiosResult.kySo || kyso || '');
    if (rowKy) axiosResult.kySo = rowKy;
    console.log('[' + product + '] axios success');
    setCache(cacheKey, axiosResult);
    await saveVietlottToSupabase(product, rowKy || axiosResult.kySo || kyso, axiosResult);
    return axiosResult;
  }

  const fallbackKySb =
    kyso ||
    (info?.currentKy != null && String(info.currentKy).trim() !== ''
      ? padVietlottId(product, info.currentKy)
      : '');
  if (fallbackKySb) {
    const staleSb = await getVietlottFromSupabase(product, fallbackKySb);
    if (staleSb) {
      console.warn(
        '[' + product + '] axios không lấy được HTML vietlott — trả dữ liệu Supabase kỳ',
        fallbackKySb
      );
      setCache(cacheKey, staleSb);
      return staleSb;
    }
  }
  const staleLatest = await getLatestVietlottFromSupabase(product);
  if (staleLatest) {
    console.warn(
      '[' + product + '] axios không lấy được HTML vietlott — trả kỳ mới nhất trong Supabase',
      staleLatest.kySo
    );
    setCache(cacheKey, staleLatest);
    return staleLatest;
  }
  if (product === 'keno' && !kyso) {
    const latestKeno = await getLatestFullKenoFromSupabase();
    if (latestKeno) {
      console.warn('[keno] axios failed — trả bản ghi Keno mới nhất từ Supabase');
      setCache(cacheKey, latestKeno);
      return latestKeno;
    }
  }

  if (product === 'mega') {
    throw new Error('Không parse được dữ liệu Mega từ HTML theo ngày');
  }
  if (product === 'max3d' || product === 'max3dpro') {
    throw new Error('Không parse được dữ liệu Max3D từ vietlott.vn');
  }
  console.log('[' + product + '] axios failed, trying puppeteer');

  return withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    const kenoNoKy = product === 'keno' && !kyso;
    let opened = false;
    let gotoErr = null;
    for (const u of tryUrls) {
      if (!u) continue;
      const isKenoListingSpa =
        kenoNoKy &&
        u.includes('/ket-qua-trung-thuong/keno') &&
        !u.includes('view-detail-keno-result') &&
        !u.includes('winning-number-keno');
      try {
        if (isKenoListingSpa) {
          try {
            await page.goto(u, { waitUntil: 'networkidle2', timeout: 90000 });
          } catch (_e1) {
            await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 45000 });
          }
        } else {
          await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 45000 });
        }
        url = u;
        opened = true;
      } catch (e) {
        gotoErr = e;
        await new Promise((r) => setTimeout(r, kenoNoKy ? 600 : 0));
        continue;
      }
      if (kenoNoKy) {
        const parsedK = await tryParseKenoCurrentFromPuppeteerPage(page);
        if (parsedK && Array.isArray(parsedK.numbers) && parsedK.numbers.length >= 10) {
          const rowKy = padVietlottId('keno', parsedK.kySo || '');
          if (rowKy) parsedK.kySo = rowKy;
          setCache(cacheKey, parsedK);
          await saveVietlottToSupabase(product, rowKy || parsedK.kySo, parsedK);
          return parsedK;
        }
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }
      break;
    }
    if (!opened) throw gotoErr || new Error('Không mở được trang kết quả');

    if (kenoNoKy) {
      const fbRaw = String(process.env.VIETLOTT_KENO_FALLBACK_ID || '').replace(/\D/g, '');
      const fbId = fbRaw ? padVietlottId('keno', fbRaw) : '';
      const fbUrl = fbId ? buildVietlottDetailUrl('keno', fbId) : null;
      if (fbUrl) {
        try {
          await page.goto(fbUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
          const parsedFb = await tryParseKenoCurrentFromPuppeteerPage(page);
          if (parsedFb && Array.isArray(parsedFb.numbers) && parsedFb.numbers.length >= 10) {
            const rowKy = padVietlottId('keno', parsedFb.kySo || '');
            if (rowKy) parsedFb.kySo = rowKy;
            setCache(cacheKey, parsedFb);
            await saveVietlottToSupabase(product, rowKy || parsedFb.kySo, parsedFb);
            return parsedFb;
          }
        } catch (_e) {
          /* ignore */
        }
      }
      throw new Error(
        'Không tìm thấy kết quả Keno (đã thử dò kỳ qua axios + SPA). Gọi /vietlott/keno?kyso= hoặc VIETLOTT_KENO_PROBE_START / VIETLOTT_KENO_FALLBACK_ID'
      );
    }

    await new Promise((r) => setTimeout(r, 3000));

    // MAX 3D / MAX 3D PRO
    if (product === 'max3d' || product === 'max3dpro') {
      const sets = await page.evaluate((PRIZE_LABELS) => {
        const allSpans = document.querySelectorAll('span[id^="max3d_G"]');
        const groups = {};
        Array.from(allSpans).forEach(span => {
          const match = span.id.match(/max3d_G(\d+)_(\d+)_(\d+)/);
          if (!match) return;
          const [, prize, set, pos] = match;
          const key = 'G' + prize + '_' + set;
          if (!groups[key]) groups[key] = { prize: 'G' + prize, set, nums: [] };
          groups[key].nums[parseInt(pos) - 1] = parseInt(span.textContent.trim());
        });
        return Object.entries(groups)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, { prize, set, nums }]) => ({
            label: (PRIZE_LABELS[prize] || prize) + ' bộ ' + set,
            numbers: nums.filter(n => !isNaN(n)),
          }));
      }, PRIZE_LABELS);

      if (sets.length === 0) throw new Error('Không tìm thấy số kết quả');

      const kySo3d = await page.evaluate(() => {
        const allTitleTt = document.querySelectorAll('div.title_tt');
        if (allTitleTt.length > 0) {
          const m = allTitleTt[0].textContent.match(/#(\d+)/);
          if (m) return m[1];
        }
        const kyveEl = document.querySelector('div.kyve');
        if (kyveEl) {
          const m = kyveEl.textContent.match(/#(\d+)/);
          if (m) return m[1];
        }
        return '';
      });

      const drawDate3d = await page.evaluate(() => {
        const allTitleTt = document.querySelectorAll('div.title_tt');
        if (allTitleTt.length > 0) {
          const m = allTitleTt[0].textContent.match(/(\d{2})\/(\d{2})\/(\d{4})/);
          if (m) return m[0];
        }
        return (() => { const d = new Date(); return String(d.getDate()).padStart(2,'0') + '/' + String(d.getMonth()+1).padStart(2,'0') + '/' + d.getFullYear(); })();
      });

      const result = { sets, drawDate: drawDate3d, kySo: kySo3d };
      if (kyso && !result.kySo) result.kySo = kyso;
      if (!result.drawDate) {
        const m = url.match(/\/(\d{2})-(\d{2})-(\d{4})\.html/);
        if (m) result.drawDate = m[1] + '/' + m[2] + '/' + m[3];
      }
      const rk = padVietlottId(product, result.kySo || kyso || '');
      if (rk) result.kySo = rk;
      setCache(cacheKey, result);
      await saveVietlottToSupabase(product, rk || result.kySo || kyso, result);
      return result;
    }

    // KENO — scrape theo kyso từ trang tra cứu (một evaluate để tránh frame detach giữa các lần gọi)
    if (product === 'keno' && kyso) {
      const { numbers: numsRaw, kySoParsed } = await page.evaluate(() => {
        const balls = document.querySelectorAll(
          'span.ball_keno, span.ball.ball_keno, span.bong_tron.small, #divKenoResultContent span.bong_tron.small'
        );
        const numbers = Array.from(balls)
          .map((e) => parseInt(e.textContent.trim(), 10))
          .filter((n) => !isNaN(n) && n >= 1 && n <= 80);
        const el = document.querySelector(
          'span#cur_ky, div.kythuong span, #divKenoResultContent table tbody tr td:nth-child(2)'
        );
        let kySoParsed = el ? el.textContent.trim().replace(/[^0-9]/g, '') : '';
        if (!kySoParsed) {
          const t2 = document.querySelector('#divKenoResultContent table tbody tr td:nth-child(2)');
          if (t2) {
            const m = (t2.textContent || '').match(/#\s*(\d+)/);
            if (m) kySoParsed = m[1];
          }
        }
        return { numbers: numbers, kySoParsed };
      });

      const result = {
        numbers: [...new Set(numsRaw)].slice(0, 20),
        kySo: kySoParsed,
        drawDate: toViDate(new Date()),
      };
      if (result.numbers.length === 0) throw new Error('Không tìm thấy số kết quả Keno');
      const rk = padVietlottId('keno', result.kySo || kyso || '');
      if (rk) result.kySo = rk;
      setCache(cacheKey, result);
      await saveVietlottToSupabase('keno', rk || result.kySo || kyso, result);
      return result;
    }

    // MEGA, POWER, LOTTO535, KENO (không kyso): một page.evaluate — ít race với timeout đóng browser
    const scraped = await page.evaluate((prod) => {
      const maps = {
        mega:     'span.ball_orange, span.ball.ball_orange',
        power:    'span.ball_power, span.ball.ball_power',
        keno:     'span.ball_keno, span.ball.ball_keno, span.bong_tron.small, #divKenoResultContent span.bong_tron.small',
        lotto535: 'span.ball_lotto',
      };
      const sel = maps[prod] || 'span[class*="ball"]';
      const els = document.querySelectorAll(sel);
      const numbers = Array.from(els)
        .map((e) => parseInt(e.textContent.trim(), 10))
        .filter((n) => !isNaN(n) && n >= 1 && (prod !== 'keno' || n <= 80));

      let powerNumber = null;
      if (prod === 'lotto535' || prod === 'power') {
        const el = document.querySelector(
          'span.ball_lotto.ball_power2, span.ball.ball_lotto.ball_power2, span.ball_power2, span.ball.ball_power2'
        );
        if (el) {
          const p = parseInt(el.textContent.trim(), 10);
          powerNumber = isNaN(p) ? null : p;
        }
      }

      let kySo = '';
      const periodEl = document.querySelector('span.period_live');
      if (periodEl) kySo = periodEl.textContent.trim().replace(/[^0-9]/g, '');
      else {
        const curKy = document.querySelector('span#cur_ky');
        if (curKy) kySo = curKy.textContent.trim().replace(/[^0-9]/g, '');
        else {
          const allTitleTt0 = document.querySelectorAll('div.title_tt');
          if (allTitleTt0.length > 0) {
            const m = allTitleTt0[0].textContent.match(/#(\d+)/);
            if (m) kySo = m[1];
          }
        }
      }

      let drawDate = '';
      const allTitleTt = document.querySelectorAll('div.title_tt');
      if (allTitleTt.length > 0) {
        const m = allTitleTt[0].textContent.match(/(\d{2})\/(\d{2})\/(\d{4})/);
        if (m) drawDate = m[0];
      }
      if (!drawDate) {
        const kythuong = document.querySelector('div.kythuong, div.kyve');
        if (kythuong) {
          const m = kythuong.textContent.match(/(\d{2})\/(\d{2})\/(\d{4})/);
          if (m) drawDate = m[0];
        }
      }
      if (!drawDate) {
        const m = document.body.innerText.match(/(\d{2})\/(\d{2})\/(\d{4})/);
        drawDate = m
          ? m[0]
          : (() => {
              const d = new Date();
              return (
                String(d.getDate()).padStart(2, '0') +
                '/' +
                String(d.getMonth() + 1).padStart(2, '0') +
                '/' +
                d.getFullYear()
              );
            })();
      }

      if (!kySo && prod === 'keno') {
        const tr = document.querySelector('#divKenoResultContent table tbody tr');
        if (tr) {
          const cells = tr.querySelectorAll('td');
          if (cells.length >= 2) {
            const mm = (cells[1].textContent || '').match(/#\s*(\d+)/);
            if (mm) kySo = mm[1];
          }
        }
      }

      return { numbers, powerNumber, kySo, drawDate };
    }, product);

    const numbers = scraped.numbers;
    const powerNumber = scraped.powerNumber;
    const kySo = scraped.kySo;
    const drawDate = scraped.drawDate;

    console.log('[' + product + '] numbers:', numbers, 'kySo:', kySo, 'drawDate:', drawDate);

    const maxMap = { keno: 20, lotto535: 5, mega: 6, power: 6 };
    const result = {
      numbers: [...new Set(numbers)].slice(0, maxMap[product] || 6),
      powerNumber,
      kySo,
      drawDate,
    };

    if (result.numbers.length === 0) {
      // Chỉ cảnh báo "chưa công bố" cho lượt dò kỳ hiện tại (không truyền kyso).
      // Nếu đang dò kỳ quá khứ mà rỗng thì trả lỗi không tìm thấy dữ liệu.
      if (!kyso) {
        const hour = new Date().getHours();
        if (hour >= 16 && hour <= 20) {
          throw new Error('Kết quả chưa được công bố. Vui lòng thử lại sau 18:30.');
        }
      }
      throw new Error(kyso ? `Không tìm thấy kết quả cho kỳ ${kyso}` : 'Không tìm thấy số kết quả');
    }
    const rk = padVietlottId(product, result.kySo || kyso || '');
    if (rk) result.kySo = rk;
    setCache(cacheKey, result);
    await saveVietlottToSupabase(product, rk || result.kySo || kyso, result);
    return result;
  });
}

const XSKT_REGIONS = {
  mb: ['Hà Nội', 'Quảng Ninh', 'Bắc Ninh', 'Hải Phòng', 'Nam Định', 'Thái Bình'],
  mt: [
    'Thừa Thiên Huế', 'Phú Yên', 'Đắk Lắk', 'Quảng Nam', 'Đà Nẵng', 'Khánh Hòa',
    'Bình Định', 'Quảng Trị', 'Quảng Bình', 'Gia Lai', 'Ninh Thuận', 'Quảng Ngãi',
    'Đắk Nông', 'Kon Tum',
  ],
  mn: [
    'TP. Hồ Chí Minh', 'TP.HCM', 'Đồng Tháp', 'Cà Mau', 'Bến Tre', 'Vũng Tàu', 'Bạc Liêu',
    'Đồng Nai', 'Cần Thơ', 'Sóc Trăng', 'Tây Ninh', 'An Giang', 'Bình Thuận',
    'Vĩnh Long', 'Bình Dương', 'Trà Vinh', 'Long An', 'Bình Phước', 'Hậu Giang',
    'Tiền Giang', 'Kiên Giang', 'Đà Lạt',
  ],
};

function normProvince(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace('tp. ho chi minh', 'tp hcm')
    .replace('tp.hcm', 'tp hcm')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectRegionByDai(dai) {
  const n = normProvince(dai);
  for (const region of ['mb', 'mt', 'mn']) {
    const hit = (XSKT_REGIONS[region] || []).some((p) => normProvince(p) === n);
    if (hit) return region;
  }
  return 'mn';
}

function parseAllXSKTByCheerio(html) {
  const $ = cheerio.load(html);
  const dateRegex = /(\d{2}\/\d{2}\/\d{4})/;
  const preferredDateText = $('div.ngay, .title_ngay, h2, h3').first().text() || '';
  const drawDateFromHtml =
    (preferredDateText.match(dateRegex) || [])[1] ||
    (($('body').text() || '').match(dateRegex) || [])[1] ||
    toViDate(new Date());

  const normalizePrizeLabel = (raw, cls = '') => {
    const text = String(raw || '').trim().toLowerCase();
    if (text.includes('đặc biệt') || cls.includes('giaidb')) return 'Giải đặc biệt';
    if (text.includes('giải nhất') || text === 'g1' || cls.includes('giai1')) return 'Giải nhất';
    if (text.includes('giải nhì') || text === 'g2' || cls.includes('giai2')) return 'Giải nhì';
    if (text.includes('giải ba') || text === 'g3' || cls.includes('giai3')) return 'Giải ba';
    if (text.includes('giải tư') || text === 'g4' || cls.includes('giai4')) return 'Giải tư';
    if (text.includes('giải năm') || text === 'g5' || cls.includes('giai5')) return 'Giải năm';
    if (text.includes('giải sáu') || text === 'g6' || cls.includes('giai6')) return 'Giải sáu';
    if (text.includes('giải bảy') || text === 'g7' || cls.includes('giai7')) return 'Giải bảy';
    if (text.includes('giải tám') || text === 'g8' || cls.includes('giai8')) return 'Giải tám';
    return String(raw || '').trim() || 'Giải';
  };

  const extractNumbers = ($cell) => {
    const byNode = $cell
      .find('div.giaiSo, span.giaiSo, b, strong')
      .map((_, el) => ($(el).text() || '').trim().replace(/\D/g, ''))
      .get()
      .filter((n) => n.length >= 2);
    if (byNode.length > 0) return byNode;
    return ($cell.text() || '')
      .split(/\s+/)
      .map((x) => x.replace(/\D/g, ''))
      .filter((n) => n.length >= 2);
  };

  const allResults = {};
  $('table.bangketquaSo').each((_, tableEl) => {
    const $table = $(tableEl);
    const provinceNames = $table.find('td.tinh')
      .map((__, el) => ($(el).text() || '').trim())
      .get()
      .filter(Boolean);
    if (provinceNames.length === 0) return;

    const provincePrizes = provinceNames.map(() => []);
    const specialByProvince = provinceNames.map(() => '');

    $table.find('tr').each((__, rowEl) => {
      const $row = $(rowEl);
      const className = String($row.attr('class') || '').toLowerCase();
      const labelCell = $row.find('td.giai, td:first-child').first();
      const rawLabel = labelCell.length ? (labelCell.text() || '').trim() : '';

      const prizeCells = $row.find('td[class*="giai"]').filter((___, cell) => {
        const cls = String($(cell).attr('class') || '').toLowerCase();
        return cls.includes('giai') && !cls.includes('giai_tinh') && !cls.includes('giai_text');
      }).toArray();
      if (prizeCells.length < provinceNames.length) return;

      const prizeLabel = normalizePrizeLabel(rawLabel, className + ' ' + String($(prizeCells[0]).attr('class') || '').toLowerCase());
      for (let i = 0; i < provinceNames.length; i++) {
        const nums = extractNumbers($(prizeCells[i]));
        if (nums.length === 0) continue;
        provincePrizes[i].push({ label: prizeLabel, numbers: nums });
        if (prizeLabel === 'Giải đặc biệt' && !specialByProvince[i]) {
          specialByProvince[i] = nums[0];
        }
      }
    });

    for (let i = 0; i < provinceNames.length; i++) {
      const daiName = provinceNames[i];
      if (!daiName || provincePrizes[i].length === 0) continue;
      const specialPrize =
        specialByProvince[i] ||
        (provincePrizes[i].find((p) => p.label === 'Giải đặc biệt')?.numbers?.[0] || '');

      allResults[daiName] = {
        specialPrize,
        prizes: provincePrizes[i],
        drawDate: drawDateFromHtml,
      };
    }
  });

  return allResults;
}

/** XS miền Bắc: một kết quả chung cho cả miền (không tách theo từng đài). */
const XSKT_MIEN_BAC_LABEL = 'Miền Bắc';

/** Minh Ngọc: trang MB dùng .box_kqxs + td.giaidb…giai7 (không có bangketquaSo / td.tinh). */
function parseMienBacMinhNgocByCheerio(html) {
  const $ = cheerio.load(html);
  const dateRegex = /(\d{2}\/\d{2}\/\d{4})/;
  const firstBox = $('.box_kqxs').first();
  if (!firstBox.length) return {};

  const titleDates = firstBox
    .find('.title a')
    .map((_, el) => {
      const t = ($(el).text() || '').trim();
      return (t.match(dateRegex) || [])[1];
    })
    .get()
    .filter(Boolean);
  const drawDate =
    titleDates[0] ||
    (firstBox.text().match(dateRegex) || [])[1] ||
    toViDate(new Date());

  const rowDefs = [
    ['giaidb', 'Giải đặc biệt'],
    ['giai1', 'Giải nhất'],
    ['giai2', 'Giải nhì'],
    ['giai3', 'Giải ba'],
    ['giai4', 'Giải tư'],
    ['giai5', 'Giải năm'],
    ['giai6', 'Giải sáu'],
    ['giai7', 'Giải bảy'],
  ];

  const prizes = [];
  let specialPrize = '';
  for (const [cls, label] of rowDefs) {
    const cell = firstBox.find(`td.${cls}`).first();
    if (!cell.length) continue;
    const nums = cell
      .find('div')
      .map((_, el) => ($(el).text() || '').trim().replace(/\D/g, ''))
      .get()
      .filter((n) => n.length >= 2);
    if (nums.length === 0) continue;
    prizes.push({ label, numbers: nums });
    if (label === 'Giải đặc biệt' && nums[0]) specialPrize = nums[0];
  }

  if (prizes.length === 0) return {};
  return {
    [XSKT_MIEN_BAC_LABEL]: {
      specialPrize:
        specialPrize ||
        prizes.find((p) => p.label === 'Giải đặc biệt')?.numbers?.[0] ||
        '',
      prizes,
      drawDate,
    },
  };
}

function normalizeMienBacXsktMap(allResults) {
  const entries = Object.entries(allResults || {});
  if (entries.length === 0) return allResults;
  let best = null;
  let bestLen = -1;
  for (const [, data] of entries) {
    const plen = Array.isArray(data?.prizes) ? data.prizes.length : 0;
    if (plen > bestLen) {
      bestLen = plen;
      best = data;
    }
  }
  if (!best) return allResults;
  return {
    [XSKT_MIEN_BAC_LABEL]: {
      specialPrize: best.specialPrize || '',
      prizes: best.prizes || [],
      drawDate: best.drawDate || '',
    },
  };
}

/** Tra cứu theo tên đài miền Bắc hoặc nhãn miền → dùng bản ghi chung. */
function isMienBacDaiQuery(dai) {
  const s = String(dai || '').trim().toLowerCase();
  if (!s) return false;
  if (s === 'mb' || s.includes('miền bắc') || s.includes('mien bac')) return true;
  const n = normProvince(dai);
  return (XSKT_REGIONS.mb || []).some((p) => normProvince(p) === n);
}

async function scrapeAllXSKT(dateStr, region = 'mn') {
  const safeRegion = ['mb', 'mt', 'mn'].includes(region) ? region : 'mn';
  const cacheKey =
    'xskt_all_' +
    safeRegion +
    '_' +
    (dateStr || 'today') +
    (safeRegion === 'mb' ? '_chung' : '');
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const mienSlug = safeRegion === 'mb' ? 'bac' : safeRegion === 'mt' ? 'trung' : 'nam';
  const base = 'https://www.minhngoc.net.vn/ket-qua-xo-so/mien-' + mienSlug;
  const url = dateStr
    ? base + '/' + dateStr + '.html'
    : base + '.html';
  console.log('[XSKT all]', safeRegion, url);
  const html = await fetchHTML(url);
  if (html) {
    let raw = parseAllXSKTByCheerio(html);
    if (Object.keys(raw).length === 0 && safeRegion === 'mb') {
      raw = parseMienBacMinhNgocByCheerio(html);
    }
    if (Object.keys(raw).length > 0) {
      const quickResults = safeRegion === 'mb' ? normalizeMienBacXsktMap(raw) : raw;
      console.log('[XSKT all] using axios+cheerio, tìm được', Object.keys(quickResults).length, 'đài');
      setCache(cacheKey, quickResults);
      return quickResults;
    }
  }

  return withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 5000));

    const results = await page.evaluate(() => {
      const MB_LABEL = 'Miền Bắc';
      const parseMbFirstBox = () => {
        const firstBox = document.querySelector('.box_kqxs');
        if (!firstBox || !firstBox.querySelector('td.giaidb')) return null;

        const dateRe = /(\d{2}\/\d{2}\/\d{4})/;
        let drawDate = '';
        for (const a of firstBox.querySelectorAll('.title a')) {
          const m = ((a.textContent || '').trim()).match(dateRe);
          if (m) {
            drawDate = m[1];
            break;
          }
        }
        if (!drawDate) {
          const m = (firstBox.textContent || '').match(dateRe);
          drawDate = m ? m[1] : (() => {
            const d = new Date();
            return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();
          })();
        }

        const rowDefs = [
          ['giaidb', 'Giải đặc biệt'],
          ['giai1', 'Giải nhất'],
          ['giai2', 'Giải nhì'],
          ['giai3', 'Giải ba'],
          ['giai4', 'Giải tư'],
          ['giai5', 'Giải năm'],
          ['giai6', 'Giải sáu'],
          ['giai7', 'Giải bảy'],
        ];
        const prizes = [];
        let specialPrize = '';
        for (const [cls, label] of rowDefs) {
          const cell = firstBox.querySelector(`td.${cls}`);
          if (!cell) continue;
          const nums = Array.from(cell.querySelectorAll('div'))
            .map((d) => (d.textContent || '').trim().replace(/\D/g, ''))
            .filter((n) => n.length >= 2);
          if (nums.length === 0) continue;
          prizes.push({ label, numbers: nums });
          if (label === 'Giải đặc biệt' && nums[0]) specialPrize = nums[0];
        }
        if (prizes.length === 0) return null;
        const sp =
          specialPrize ||
          (prizes.find((p) => p.label === 'Giải đặc biệt')?.numbers?.[0] || '');
        return { [MB_LABEL]: { specialPrize: sp, prizes, drawDate } };
      };

      const mbFirst = parseMbFirstBox();
      if (mbFirst) return mbFirst;

      const normalizePrizeLabel = (raw, cls = '') => {
        const text = String(raw || '').trim().toLowerCase();
        if (text.includes('đặc biệt') || cls.includes('giaidb')) return 'Giải đặc biệt';
        if (text.includes('giải nhất') || text === 'g1' || cls.includes('giai1')) return 'Giải nhất';
        if (text.includes('giải nhì') || text === 'g2' || cls.includes('giai2')) return 'Giải nhì';
        if (text.includes('giải ba') || text === 'g3' || cls.includes('giai3')) return 'Giải ba';
        if (text.includes('giải tư') || text === 'g4' || cls.includes('giai4')) return 'Giải tư';
        if (text.includes('giải năm') || text === 'g5' || cls.includes('giai5')) return 'Giải năm';
        if (text.includes('giải sáu') || text === 'g6' || cls.includes('giai6')) return 'Giải sáu';
        if (text.includes('giải bảy') || text === 'g7' || cls.includes('giai7')) return 'Giải bảy';
        if (text.includes('giải tám') || text === 'g8' || cls.includes('giai8')) return 'Giải tám';
        return String(raw || '').trim() || 'Giải';
      };

      const extractNumbers = (cell) => {
        const byNode = Array.from(cell.querySelectorAll('div.giaiSo, span.giaiSo, b, strong'))
          .map((el) => (el.textContent || '').trim().replace(/\D/g, ''))
          .filter((n) => n.length >= 2);
        if (byNode.length > 0) return byNode;
        const fallback = (cell.textContent || '')
          .split(/\s+/)
          .map((x) => x.replace(/\D/g, ''))
          .filter((n) => n.length >= 2);
        return fallback;
      };

      const allResults = {};
      document.querySelectorAll('table.bangketquaSo').forEach(table => {
        const provinceNames = Array.from(table.querySelectorAll('td.tinh'))
          .map((el) => (el.textContent || '').trim())
          .filter(Boolean);
        if (provinceNames.length === 0) return;

        const provincePrizes = provinceNames.map(() => []);
        const specialByProvince = provinceNames.map(() => '');

        Array.from(table.querySelectorAll('tr')).forEach((row) => {
          const className = String(row.className || '').toLowerCase();
          const labelCell = row.querySelector('td.giai, td:first-child');
          const rawLabel = labelCell ? (labelCell.textContent || '').trim() : '';
          const prizeCells = Array.from(row.querySelectorAll('td[class*="giai"]')).filter((cell) => {
            const cls = String(cell.className || '').toLowerCase();
            return cls.includes('giai') && !cls.includes('giai_tinh') && !cls.includes('giai_text');
          });
          if (prizeCells.length < provinceNames.length) return;

          const prizeLabel = normalizePrizeLabel(rawLabel, className + ' ' + String(prizeCells[0].className || '').toLowerCase());
          for (let i = 0; i < provinceNames.length; i++) {
            const nums = extractNumbers(prizeCells[i]);
            if (nums.length === 0) continue;
            provincePrizes[i].push({ label: prizeLabel, numbers: nums });
            if (prizeLabel === 'Giải đặc biệt' && !specialByProvince[i]) {
              specialByProvince[i] = nums[0];
            }
          }
        });

        for (let i = 0; i < provinceNames.length; i++) {
          const daiName = provinceNames[i];
          if (!daiName || provincePrizes[i].length === 0) continue;
          const specialPrize =
            specialByProvince[i] ||
            (provincePrizes[i].find((p) => p.label === 'Giải đặc biệt')?.numbers?.[0] || '');

          allResults[daiName] = {
            specialPrize,
            prizes: provincePrizes[i],
            drawDate: (() => { const d = new Date(); return String(d.getDate()).padStart(2,'0') + '/' + String(d.getMonth()+1).padStart(2,'0') + '/' + d.getFullYear(); })(),
          };
        }
      });
      return allResults;
    });

    let finalResults = safeRegion === 'mb' ? normalizeMienBacXsktMap(results) : results;
    console.log('[XSKT all] Tìm được', Object.keys(finalResults).length, 'đài');
    setCache(cacheKey, finalResults);
    return finalResults;
  });
}
/**
 * Gọi scrape theo từng kỳ gần đây để upsert vào Supabase (bỏ qua kỳ đã có đủ dữ liệu).
 * VIETLOTT_WARM_DEPTH (mặc định 10), VIETLOTT_WARM_DELAY_MS (mặc định 500).
 */
async function warmVietlottRecentToSupabase() {
  if (!supabase) {
    console.log('[warm vietlott] Bỏ qua — chưa cấu hình SUPABASE_URL hoặc khóa Supabase');
    return;
  }
  const depth = Math.max(1, Math.min(40, parseInt(process.env.VIETLOTT_WARM_DEPTH || '10', 10)));
  const delayMs = Math.max(200, Math.min(3000, parseInt(process.env.VIETLOTT_WARM_DELAY_MS || '500', 10)));

  for (const product of VIETLOTT_PRODUCT_IDS) {
    try {
      const info = await getCurrentInfo(product);
      const cur = parseInt(String(info?.currentKy || '').replace(/\D/g, ''), 10);
      if (Number.isNaN(cur) || cur < 1) continue;

      const maxBack = product === 'keno' ? Math.min(depth, 12) : depth;
      for (let i = 0; i < maxBack; i++) {
        const n = cur - i;
        if (n < 1) break;
        const kyStr = padVietlottId(product, n);
        const had = await getVietlottFromSupabase(product, kyStr);
        const filled =
          had &&
          ((Array.isArray(had.numbers) && had.numbers.length > 0) ||
            (Array.isArray(had.sets) && had.sets.length > 0));
        if (filled) continue;
        await scrapeVietlott(product, kyStr).catch(() => {});
        await new Promise((r) => setTimeout(r, delayMs));
      }
    } catch (e) {
      console.warn('[warm vietlott]', product, e.message);
    }
  }
  console.log('[warm vietlott] Hoàn tất một vòng');
}

/** Ước lượng số kỳ cần lùi để phủ ~months tháng (Keno có trần env). */
function estimateBackfillSteps(product, months) {
  const m = Math.max(1, Math.min(24, months));
  if (product === 'lotto535') {
    return Math.ceil(m * 31 * 2.1);
  }
  if (product === 'keno') {
    const cap = Math.max(500, Math.min(20000, parseInt(process.env.VIETLOTT_BACKFILL_KENO_MAX || '6000', 10)));
    const est = Math.ceil(m * 30 * 130);
    return Math.min(cap, Math.max(est, 200));
  }
  return Math.ceil(m * 4.5 * 3 * 1.2);
}

/** Ước lượng số kỳ lùi theo N ngày (sync-history theo ngày). Keno: ~130 kỳ/ngày, có trần env. */
function estimateBackfillStepsForDays(product, days) {
  const d = Math.max(1, Math.min(120, days));
  const m = d / 30;
  if (product === 'lotto535') {
    return Math.ceil(m * 31 * 2.1);
  }
  if (product === 'keno') {
    const cap = Math.max(
      500,
      Math.min(20000, parseInt(process.env.VIETLOTT_BACKFILL_KENO_MAX || '6000', 10))
    );
    const est = Math.ceil(d * 130);
    return Math.min(cap, Math.max(est, 50));
  }
  return Math.max(1, Math.ceil(m * 4.5 * 3 * 1.2));
}

/**
 * Lùi từ kỳ hiện tại, scrape từng kỳ và upsert Supabase (bỏ qua kỳ đã có đủ dữ liệu).
 * options.days — nếu có, dùng estimateBackfillStepsForDays (ưu tiên hơn months).
 * options.kenoDays — cửa sổ riêng cho Keno (ngày); không set thì Keno dùng chung options.days.
 */
async function backfillVietlottMonthsToSupabase(months, options) {
  const opts = options || {};
  const delayMs = Math.max(
    100,
    Math.min(2500, parseInt(process.env.VIETLOTT_BACKFILL_DELAY_MS || '350', 10))
  );
  const products = (opts.products || VIETLOTT_PRODUCT_IDS).filter((p) =>
    VIETLOTT_PRODUCT_IDS.includes(p)
  );

  const dayWindow =
    opts.days != null && Number.isFinite(Number(opts.days)) ? Number(opts.days) : null;
  const kenoDayWindow =
    opts.kenoDays != null && Number.isFinite(Number(opts.kenoDays))
      ? Number(opts.kenoDays)
      : null;

  const stats = {
    months: dayWindow != null ? null : months,
    days: dayWindow,
    kenoDays: kenoDayWindow,
    products,
    byProduct: {},
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };

  for (const product of products) {
    const by = { skipped: 0, fetched: 0, errors: 0, steps: 0, planned: 0 };
    stats.byProduct[product] = by;
    if (product === 'lotto535') {
      console.warn('[backfill] lotto535 skipped — use date-based backfill instead');
      by.skipped++;
      continue;
    }
    try {
      const info = await getCurrentInfo(product);
      const cur = parseInt(String(info?.currentKy || '').replace(/\D/g, ''), 10);
      if (Number.isNaN(cur) || cur < 1) {
        by.errors++;
        continue;
      }
      let depthDays = dayWindow;
      if (product === 'keno' && kenoDayWindow != null) {
        depthDays = kenoDayWindow;
      }
      const depth =
        depthDays != null
          ? estimateBackfillStepsForDays(product, depthDays)
          : estimateBackfillSteps(product, months);
      by.planned = depth;
      for (let i = 0; i < depth; i++) {
        const n = cur - i;
        if (n < 1) break;
        const kyStr = padVietlottId(product, n);
        by.steps++;
        const had = await getVietlottFromSupabase(product, kyStr);
        const filled =
          had &&
          ((Array.isArray(had.numbers) && had.numbers.length > 0) ||
            (Array.isArray(had.sets) && had.sets.length > 0));
        if (filled) {
          by.skipped++;
          continue;
        }
        try {
          const result = await scrapeVietlott(product, kyStr);
          const ok =
            result &&
            ((Array.isArray(result.numbers) && result.numbers.length > 0) ||
              (Array.isArray(result.sets) && result.sets.length > 0));
          if (ok) by.fetched++;
          else by.errors++;
        } catch (_e) {
          by.errors++;
        }
        await new Promise((r) => setTimeout(r, delayMs));
      }
    } catch (e) {
      by.errors++;
      console.warn('[backfill vietlott]', product, e.message);
    }
  }
  stats.finishedAt = new Date().toISOString();
  return stats;
}

/** Slug ngày cho URL Minh Ngọc: DD-MM-YYYY */
function formatMinhNgocDaySlug(date) {
  const d = date instanceof Date ? new Date(date.getTime()) : new Date(date);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return dd + '-' + mm + '-' + yyyy;
}

/**
 * Quét XSKT theo từng ngày trong [startDate, endDate], upsert Supabase (mb / mt / mn).
 * Tránh gọi quá dày: delay giữa mỗi lần scrape (mặc định từ env XSKT_BACKFILL_DELAY_MS hoặc 400).
 */
async function backfillXSKTDateRangeToSupabase(startDate, endDate, options) {
  const opts = options || {};
  const delayMs = Math.max(
    50,
    Math.min(
      3000,
      parseInt(
        opts.delayMs !== undefined ? opts.delayMs : process.env.XSKT_BACKFILL_DELAY_MS || '400',
        10
      )
    )
  );
  const regions = opts.regions || ['mb', 'mt', 'mn'];

  let start = startDate instanceof Date ? new Date(startDate.getTime()) : new Date(startDate);
  let end = endDate instanceof Date ? new Date(endDate.getTime()) : new Date(endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error('backfillXSKTDateRangeToSupabase: ngày không hợp lệ');
  }
  if (start > end) {
    const tmp = start;
    start = end;
    end = tmp;
  }
  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);

  const stats = {
    start: formatMinhNgocDaySlug(start),
    end: formatMinhNgocDaySlug(end),
    daysProcessed: 0,
    rowsSaved: 0,
    emptyResults: 0,
    errors: 0,
    byRegion: {},
  };
  for (const r of regions) {
    stats.byRegion[r] = { ok: 0, empty: 0, err: 0 };
  }

  const oneDayMs = 86400000;
  for (let time = start.getTime(); time <= end.getTime(); time += oneDayMs) {
    const cur = new Date(time);
    const slug = formatMinhNgocDaySlug(cur);
    stats.daysProcessed++;

    for (const region of regions) {
      try {
        const all = await scrapeAllXSKT(slug, region);
        const keys = Object.keys(all);
        if (keys.length === 0) {
          stats.emptyResults++;
          stats.byRegion[region].empty++;
          continue;
        }
        for (const [dai, row] of Object.entries(all)) {
          await saveXSKTToSupabase(dai, row.drawDate, row);
          stats.rowsSaved++;
        }
        stats.byRegion[region].ok++;
      } catch (e) {
        stats.errors++;
        stats.byRegion[region].err++;
        console.warn('[xskt backfill]', slug, region, e.message);
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  return stats;
}

module.exports = {
  VIETLOTT_PRODUCT_IDS,
  DRAW_DAYS,
  toViDate,
  normalizeDrawDateForSupabase,
  detectRegionByDai,
  scrapeVietlott,
  scrapeAllXSKT,
  saveVietlottToSupabase,
  saveXSKTToSupabase,
  getVietlottFromSupabase,
  getLatestVietlottFromSupabase,
  getXSKTFromSupabase,
  getCurrentInfo,
  getUrlFromKySo,
  padVietlottId,
  buildVietlottDetailUrl,
  buildVietlottListingUrl,
  getCache,
  setCache,
  scrapeWithAxios,
  warmVietlottRecentToSupabase,
  estimateBackfillSteps,
  estimateBackfillStepsForDays,
  backfillVietlottMonthsToSupabase,
  formatMinhNgocDaySlug,
  backfillXSKTDateRangeToSupabase,
  XSKT_MIEN_BAC_LABEL,
  isMienBacDaiQuery,
};
