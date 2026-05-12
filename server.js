const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const cron = require('node-cron');
const axios = require('axios');
const cheerio = require('cheerio');
const { createClient } = require('@supabase/supabase-js');

const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  : null;

const VIETLOTT_PROXY = process.env.VIETLOTT_PROXY_URL || '';

const app = express();
app.use(cors());
app.use(express.json());
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

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
    await supabase.from('vietlott_results').upsert({
      product,
      kyso: key,
      draw_date: data.drawDate || '',
      numbers: data.numbers || [],
      power_number: data.powerNumber || null,
      sets: data.sets || null,
    }, { onConflict: 'product,kyso' });
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
        drawDate: data.draw_date,
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
          drawDate: row.draw_date,
        };
      }
    }
    return null;
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
    await supabase.from('xskt_results').upsert({
      dai,
      draw_date: drawDate,
      special_prize: data.specialPrize || '',
      prizes: data.prizes || [],
    }, { onConflict: 'dai,draw_date' });
    console.log('[supabase] saved xskt', dai, drawDate);
  } catch (e) {
    console.error('[supabase] save xskt error:', e.message);
  }
}

// Lấy kết quả XSKT từ Supabase
async function getXSKTFromSupabase(dai, drawDate) {
  if (!supabase || !drawDate) return null;
  try {
    const { data, error } = await supabase
      .from('xskt_results')
      .select('*')
      .eq('dai', dai)
      .eq('draw_date', drawDate)
      .single();
    if (error || !data) return null;
    console.log('[supabase] cache hit xskt', dai, drawDate);
    return {
      specialPrize: data.special_prize,
      prizes: data.prizes,
      drawDate: data.draw_date,
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

/**
 * Gọi scrape theo từng kỳ gần đây để upsert vào Supabase (bỏ qua kỳ đã có đủ dữ liệu).
 * VIETLOTT_WARM_DEPTH (mặc định 10), VIETLOTT_WARM_DELAY_MS (mặc định 500),
 * VIETLOTT_WARM_ON_BOOT=0 để tắt warm lúc khởi động.
 */
async function warmVietlottRecentToSupabase() {
  if (!supabase) {
    console.log('[warm vietlott] Bỏ qua — chưa cấu hình SUPABASE_URL / SUPABASE_ANON_KEY');
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
  const m = Math.max(1, Math.min(6, months));
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

/**
 * Lùi từ kỳ hiện tại, scrape từng kỳ và upsert Supabase (bỏ qua kỳ đã có đủ dữ liệu).
 * scrapeVietlott đã gọi saveVietlottToSupabase khi thành công.
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

  const stats = {
    months,
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
      const depth = estimateBackfillSteps(product, months);
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

// Scrape Keno theo kyso — dùng trang tra cứu
async function scrapeKenoByKySo(kyso) {
  const cacheKey = 'vl_keno_' + kyso;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const officialUrl = buildVietlottDetailUrl('keno', padVietlottId('keno', kyso));
  if (officialUrl) {
    const parsedOfficial = await scrapeWithAxios(officialUrl, 'keno', String(kyso));
    if (parsedOfficial && Array.isArray(parsedOfficial.numbers) && parsedOfficial.numbers.length >= 10) {
      if (!parsedOfficial.drawDate) parsedOfficial.drawDate = toViDate(new Date());
      setCache(cacheKey, parsedOfficial);
      return parsedOfficial;
    }
  }

  const kenoListUrl = buildVietlottListingUrl('keno');
  if (kenoListUrl) {
    const parsedList = await scrapeWithAxios(kenoListUrl, 'keno', String(kyso));
    if (parsedList && Array.isArray(parsedList.numbers) && parsedList.numbers.length > 0) {
      if (!parsedList.drawDate) parsedList.drawDate = toViDate(new Date());
      setCache(cacheKey, parsedList);
      return parsedList;
    }
  }

  // ketquadientoan (live + trang theo ngày): đã tắt — chỉ còn vietlott ở trên.

  throw new Error('Không tìm thấy dữ liệu Keno cho kỳ ' + kyso);
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

async function scrapeAllXSKT(dateStr, region = 'mn') {
  const safeRegion = ['mb', 'mt', 'mn'].includes(region) ? region : 'mn';
  const cacheKey = 'xskt_all_' + safeRegion + '_' + (dateStr || 'today');
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const url = dateStr
    ? 'https://www.minhngoc.net.vn/ket-qua-xo-so/mien-' + (safeRegion === 'mb' ? 'bac' : safeRegion === 'mt' ? 'trung' : 'nam') + '/' + dateStr + '.html'
    : 'https://www.minhngoc.net.vn/';

  const html = await fetchHTML(url);
  if (html) {
    const quickResults = parseAllXSKTByCheerio(html);
    if (Object.keys(quickResults).length > 0) {
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

    console.log('[XSKT all] Tìm được', Object.keys(results).length, 'đài');
    setCache(cacheKey, results);
    return results;
  });
}

async function scrapeXSKT(dai, dateStr, region) {
  const preferredRegion = region || detectRegionByDai(dai);
  const drawDateKey = dateStr || toViDate(new Date());

  const sbCached = await getXSKTFromSupabase(dai, drawDateKey);
  if (sbCached) return sbCached;

  let allResults = await scrapeAllXSKT(dateStr, preferredRegion);
  const keys = Object.keys(allResults);

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

    const info = await getCurrentInfo(product);
    if (!info.currentKy) throw new Error('Không lấy được kỳ hiện tại');

    const currentKyNum = parseInt(info.currentKy);
    const [dd, mm, yyyy] = info.currentDate.split('/');
    let current = new Date(parseInt(yyyy), parseInt(mm)-1, parseInt(dd));

    const DAY_NAMES = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
    const limit = product === 'keno' ? 200 : product === 'lotto535' ? 180 : 90;
    const list = [];
    let kyNum = currentKyNum;

    for (let i = 0; i < limit; i++) {
      const d = String(current.getDate()).padStart(2, '0');
      const m2 = String(current.getMonth() + 1).padStart(2, '0');
      const y2 = current.getFullYear();
      list.push({
        kyso: String(kyNum).padStart(5, '0'),
        date: d + '/' + m2 + '/' + y2,
        drawDay: DAY_NAMES[current.getDay()],
      });
      kyNum--;
      do {
        current.setDate(current.getDate() - 1);
      } while (!drawDays.includes(current.getDay()));
    }

    cache[listCacheKey] = { data: list, timestamp: Date.now() - CACHE_TTL + 30 * 60 * 1000 };
    res.json({ success: true, data: list });
  } catch(e) {
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log('✅ Doxoso API server chạy tại http://localhost:' + PORT);
  console.log('✅ Mobile access: http://172.20.10.12:' + PORT);
});