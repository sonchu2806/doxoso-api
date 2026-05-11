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

/** Trực tiếp ketquadientoan — chỉ dùng sau khi đã thử vietlott.vn. */
const VL_URLS = {
  mega:     'https://www.ketquadientoan.com/truc-tiep-xo-so-dien-toan-mega-6-45.html',
  power:    'https://www.ketquadientoan.com/truc-tiep-xo-so-dien-toan-power-655.html',
  keno:     'https://www.ketquadientoan.com/truc-tiep-xo-so-dien-toan-keno.html',
  max3d:    'https://www.ketquadientoan.com/truc-tiep-xo-so-dien-toan-max-3d.html',
  max3dpro: 'https://www.ketquadientoan.com/truc-tiep-xo-so-dien-toan-max3d-pro.html',
  lotto535: 'https://www.ketquadientoan.com/truc-tiep-xo-so-dien-toan-lotto-535.html',
};

/** Chỉ các game Vietlott — mọi logic ưu tiên vietlott.vn / VL_URLS chỉ dùng trong nhánh này, không áp dụng cho XSKT. */
const VIETLOTT_PRODUCT_IDS = ['mega', 'power', 'max3d', 'max3dpro', 'lotto535', 'keno'];

const BASE_URL_MAP = {
  mega:     'ket-qua-xo-so-dien-toan-mega-6-45',
  power:    'ket-qua-xo-so-dien-toan-power-655',
  keno:     'ket-qua-xo-so-dien-toan-keno',
  max3d:    'ket-qua-xo-so-dien-toan-max-3d',
  max3dpro: 'ket-qua-xo-so-dien-toan-max3d-pro',
  lotto535: 'ket-qua-xo-so-dien-toan-lotto-535',
};

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
    return 'https://vietlott.vn/vi/trung-thuong/ket-qua-trung-thuong/keno';
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
  // Chờ nếu đang có quá nhiều browser
  while (activeBrowsers >= MAX_CONCURRENT) {
    await new Promise(r => setTimeout(r, 500));
  }

  activeBrowsers++;
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--ignore-certificate-errors',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-extensions',
    ],
  });

  // Auto-kill browser sau 60 giây
  const timeout = setTimeout(() => {
    console.warn('[withBrowser] Timeout — force closing browser');
    browser.close().catch(() => {});
  }, 60000);

  try {
    return await fn(browser);
  } finally {
    clearTimeout(timeout);
    activeBrowsers--;
    browser.close().catch(() => {});
  }
}

// Lấy kỳ hiện tại + ngày từ trang trực tiếp
async function getCurrentInfo(product) {
  const cacheKey = 'current_' + product;
  const cached = cache[cacheKey];
  if (cached && Date.now() - cached.timestamp < 60 * 60 * 1000) return cached.data;

  try {
    let currentKy = '';
    let currentDate = '';

    if (product === 'max3d' || product === 'max3dpro') {
      const drawDays = new Set(DRAW_DAYS[product] || []);
      const now = new Date();
      const beforeCutoff = now.getHours() < 18 || (now.getHours() === 18 && now.getMinutes() < 30);
      const startDate = new Date(now);
      // Trước 18:30 của ngày quay thì dùng kỳ trước đó.
      if (beforeCutoff && drawDays.has(startDate.getDay())) {
        startDate.setDate(startDate.getDate() - 1);
      }

      // thử từ startDate lùi tối đa 14 ngày quay gần nhất.
      for (let offset = 0; offset < 14; offset++) {
        const day = new Date(startDate);
        day.setDate(startDate.getDate() - offset);
        if (!drawDays.has(day.getDay())) continue;
        const dd = String(day.getDate()).padStart(2, '0');
        const mm = String(day.getMonth() + 1).padStart(2, '0');
        const yyyy = day.getFullYear();
        const fallbackDate = dd + '/' + mm + '/' + yyyy;
        const todayUrl = 'https://www.ketquadientoan.com/' + BASE_URL_MAP[product] + '/' + dd + '-' + mm + '-' + yyyy + '.html';

        try {
          // Chỉ chấp nhận kỳ có dữ liệu sets thật, tránh dính kỳ "chưa quay".
          const parsed = await scrapeWithAxios(todayUrl, product);
          if (parsed && Array.isArray(parsed.sets) && parsed.sets.length > 0) {
            currentKy = parsed.kySo || '';
            currentDate = parsed.drawDate || fallbackDate;
          }
          if (currentKy && currentDate) break;
        } catch (_e) {
          // tiếp tục thử ngày trước đó
        }
      }
    } else if (product === 'mega' || product === 'power') {
      // Mega/Power: dùng trang theo ngày để tránh sai kỳ trước giờ quay (18:30).
      const drawDays = new Set(DRAW_DAYS[product] || []);
      const now = new Date();
      const beforeCutoff = now.getHours() < 18 || (now.getHours() === 18 && now.getMinutes() < 30);
      const startDate = new Date(now);
      if (beforeCutoff && drawDays.has(startDate.getDay())) {
        startDate.setDate(startDate.getDate() - 1);
      }

      for (let offset = 0; offset < 21; offset++) {
        const day = new Date(startDate);
        day.setDate(startDate.getDate() - offset);
        if (!drawDays.has(day.getDay())) continue;
        const daySlug = toSlugDate(day);
        const dayVi = toViDate(day);
        const dayUrl = 'https://www.ketquadientoan.com/' + BASE_URL_MAP[product] + '/' + daySlug + '.html';

        try {
          const { data: html } = await axios.get(dayUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Accept-Language': 'vi-VN,vi;q=0.9',
            },
            timeout: 20000,
          });
          const $ = cheerio.load(html);
          const sourceText =
            $('div.title_tt').first().text() ||
            $('div.kyve').first().text() ||
            $('div.kythuong').first().text() ||
            $('span.period_live').first().text() ||
            '';
          const kyMatch = sourceText.match(/#(\d+)/);
          const dateMatch = sourceText.match(/(\d{2})\/(\d{2})\/(\d{4})/);
          if (kyMatch) currentKy = kyMatch[1];
          currentDate = dateMatch ? dateMatch[0] : dayVi;
          if (currentKy) break;
        } catch (_e) {
          // thử ngày quay trước đó
        }
      }
    } else {
      const url = VL_URLS[product];
      if (!url) return { currentKy: '', currentDate: '' };

      const { data: html } = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept-Language': 'vi-VN,vi;q=0.9',
        },
        timeout: 20000,
      });

      const $ = cheerio.load(html);

      // Thử div.kythuong
      const kythuong = $('div.kythuong').first().text();
      if (kythuong) {
        const kyMatch = kythuong.match(/#(\d+)/);
        const dateMatch = kythuong.match(/(\d{2})\/(\d{2})\/(\d{4})/);
        if (kyMatch) currentKy = kyMatch[1];
        if (dateMatch) currentDate = dateMatch[0];
      }

      // Thử div.kyve
      if (!currentKy) {
        const kyve = $('div.kyve').first().text();
        if (kyve) {
          const kyMatch = kyve.match(/#(\d+)/);
          const dateMatch = kyve.match(/(\d{2})\/(\d{2})\/(\d{4})/);
          if (kyMatch) currentKy = kyMatch[1];
          if (dateMatch && !currentDate) currentDate = dateMatch[0];
        }
      }

      // Thử span.period_live
      if (!currentKy) {
        const period = $('span.period_live').first().text();
        if (period) currentKy = period.replace(/[^0-9]/g, '');
      }

      // Thử span#cur_ky cho keno
      if (!currentKy) {
        const curKy = $('span#cur_ky').first().text();
        if (curKy) currentKy = curKy.replace(/[^0-9]/g, '');
      }
    }

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

async function findDateUrlByKySo(product, kyso, lookbackDays = 90) {
  const baseSlug = BASE_URL_MAP[product];
  if (!baseSlug || !kyso) return null;
  const drawDays = new Set(DRAW_DAYS[product] || [0, 1, 2, 3, 4, 5, 6]);
  const normalizedKy = String(kyso).replace(/^0+/, '');
  const targetRegex = new RegExp('#0*' + normalizedKy + '\\b');

  for (let i = 0; i < lookbackDays; i++) {
    const day = new Date();
    day.setDate(day.getDate() - i);
    if (!drawDays.has(day.getDay())) continue;

    const dd = String(day.getDate()).padStart(2, '0');
    const mm = String(day.getMonth() + 1).padStart(2, '0');
    const yyyy = day.getFullYear();
    const url = 'https://www.ketquadientoan.com/' + baseSlug + '/' + dd + '-' + mm + '-' + yyyy + '.html';

    try {
      const { data: html } = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept-Language': 'vi-VN,vi;q=0.9',
        },
        timeout: 3500,
      });
      if (targetRegex.test(String(html || ''))) {
        // Xác thực lại bằng parser để tránh false positive từ danh sách/link liên quan.
        const parsed = await scrapeWithAxios(url, product, String(kyso));
        const parsedKy = String(parsed?.kySo || '').replace(/^0+/, '');
        if (parsed && parsedKy === normalizedKy) {
          return url;
        }
      }
    } catch (_e) {
      // bỏ qua ngày lỗi, thử ngày tiếp theo
    }
  }
  return null;
}

// Tính URL từ kyso
async function getUrlFromKySo(product, kyso) {
  if (!kyso) {
    if (VIETLOTT_PRODUCT_IDS.includes(product)) {
      return buildVietlottListingUrl(product) || VL_URLS[product] || '';
    }
    return VL_URLS[product] || '';
  }

  if (!VIETLOTT_PRODUCT_IDS.includes(product)) {
    return VL_URLS[product] || '';
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
  const wrap = isPro ? $('#divMax3DProPlus') : $('#divMax3D');
  const table = wrap.find('table.table-hover').first();
  if (!table.length) return null;
  const sets = [];
  const seenRowSig = new Set();
  table.find('tbody tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 2) return;
    const labelText = tds.eq(0).text().replace(/\s+/g, ' ').trim().toLowerCase();
    let base = '';
    if (labelText.includes('đặc biệt')) base = 'Đặc biệt';
    else if (labelText.includes('nhất')) base = 'Giải nhất';
    else if (labelText.includes('nhì')) base = 'Giải nhì';
    else if (labelText.includes('ba')) base = 'Giải ba';
    else return;
    const cell = tds.eq(1);
    const parts = [];
    cell.find('span.red').each((_, sp) => {
      const w = $(sp).text().trim();
      if (/^\d{3}$/.test(w)) parts.push(w);
    });
    if (parts.length === 0) {
      cell.find('span').each((_, sp) => {
        const w = $(sp).text().trim();
        if (/^\d{3}$/.test(w)) parts.push(w);
      });
    }
    if (parts.length === 0) {
      const raw = cell.text().replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
      const m = raw.match(/\d{3}/g);
      if (m) parts.push(...m);
    }
    const rowSig = base + '|' + parts.slice().sort().join(',');
    if (seenRowSig.has(rowSig)) return;
    seenRowSig.add(rowSig);
    parts.forEach((w, idx) => {
      sets.push({
        label: base + ' bộ ' + (idx + 1),
        numbers: w.split('').map((c) => parseInt(c, 10)),
      });
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
  const main = [];
  let powerNumber = null;
  box.find('span.bong_tron').each((_, el) => {
    const $el = $(el);
    const cls = $el.attr('class') || '';
    const t = parseInt($el.text().trim(), 10);
    if (Number.isNaN(t)) return;
    if (cls.includes('active')) powerNumber = t;
    else main.push(t);
  });
  const blob = area.text();
  let { kySo, drawDate } = extractKyAndDateFromText(blob);

  if (product === 'mega') {
    if (main.length === 6 && powerNumber === null) {
      return { numbers: main, powerNumber: null, kySo, drawDate };
    }
    return null;
  }
  if (product === 'power') {
    const nums = [...main];
    if (powerNumber === null && nums.length === 7) powerNumber = nums.pop();
    if (nums.length === 6 && powerNumber !== null) {
      return { numbers: nums, powerNumber, kySo, drawDate };
    }
    return null;
  }
  if (product === 'lotto535') {
    const nums = [...main];
    if (powerNumber === null && nums.length === 6) powerNumber = nums.pop();
    if (nums.length === 5 && powerNumber !== null) {
      return { numbers: nums, powerNumber, kySo, drawDate };
    }
    return null;
  }
  return null;
}

function parseOfficialKenoFromVietlott($, kysoTarget) {
  let row = null;
  $('table tbody tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 3) return;
    const nBong = tds.eq(2).find('span.bong_tron').length;
    if (nBong >= 10) {
      row = tr;
      return false;
    }
  });
  if (!row) return null;
  const tds = $(row).find('td');
  const drawDate = (tds.eq(0).text().match(/\d{2}\/\d{2}\/\d{4}/) || [])[0] || '';
  const kyCell = tds.eq(1).text();
  let kySo = (kyCell.match(/#\s*(\d+)/) || [])[1] || '';
  if (!kySo) kySo = (kyCell.match(/(\d{6,})/) || [])[1] || '';
  const cellForNums = tds.length >= 3 ? tds.eq(2) : $(row);
  const nums = [];
  cellForNums.find('span.bong_tron').each((_, el) => {
    const n = parseInt($(el).text().trim(), 10);
    if (!Number.isNaN(n) && n >= 1 && n <= 80) nums.push(n);
  });
  const unique = [...new Set(nums)].slice(0, 20);
  if (unique.length < 10) return null;
  if (!kySo && kysoTarget) kySo = String(kysoTarget).replace(/\D/g, '');
  return { numbers: unique, powerNumber: null, kySo, drawDate };
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
    const isVietlott = String(url).includes('vietlott.vn');
    const { data: html } = await axios.get(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'vi-VN,vi;q=0.9,en;q=0.8',
      },
      timeout: isVietlott ? 20000 : 15000,
    });

    const $ = cheerio.load(html);

    if (isVietlott) {
      const offic = parseVietlottOfficialHtml($, product, kysoTarget);
      if (offic) return offic;
      if (['mega', 'power', 'max3d', 'max3dpro', 'lotto535', 'keno'].includes(product)) {
        console.log('[scrapeWithAxios] vietlott.vn parse failed', product);
        return null;
      }
    }

    // MAX 3D
    if (product === 'max3d' || product === 'max3dpro') {
      console.log('[max3d axios] span count:', $('span[id^="max3d_G"]').length);
      const isProProduct = product === 'max3dpro';
      const matchProductContext = (textRaw) => {
        const t = String(textRaw || '').toLowerCase();
        const hasPro = /max\s*3d\s*pro|max3d\s*pro|3d\s*pro/.test(t);
        if (isProProduct) return hasPro;
        return !hasPro;
      };
      const parse3dSetsFromTable = (tableRef) => {
        const sets = [];
        const pushTriples = (label, digits, expected) => {
          const maxLen = Math.min(digits.length, expected * 3);
          let setNo = 1;
          for (let i = 0; i + 2 < maxLen; i += 3) {
            sets.push({
              label: label + ' bộ ' + setNo,
              numbers: [digits[i], digits[i + 1], digits[i + 2]],
            });
            setNo++;
          }
        };
        tableRef.find('tr').each((__, tr) => {
          const tds = $(tr).find('td');
          if (tds.length < 2) return;
          const labelText = tds.eq(0).text().replace(/\s+/g, ' ').trim().toLowerCase();
          const numText = tds.eq(1).text().replace(/\s+/g, ' ').trim();
          const digits = numText.split(' ').map((x) => parseInt(x, 10)).filter((n) => !Number.isNaN(n) && n >= 0 && n <= 9);
          if (digits.length < 3) return;
          if (labelText.includes('đặc biệt')) pushTriples('Đặc biệt', digits, 2);
          else if (labelText.includes('giải nhất')) pushTriples('Giải nhất', digits, 4);
          else if (labelText.includes('giải nhì')) pushTriples('Giải nhì', digits, 6);
          else if (labelText.includes('giải ba')) pushTriples('Giải ba', digits, 8);
        });
        return sets;
      };

      if ($('span[id^="max3d_G"]').length > 0) {
        const groups = {};
        $('span[id^="max3d_G"]').each((_, el) => {
          const match = el.attribs?.id?.match(/max3d_G(\d+)_(\d+)_(\d+)/);
          if (!match) return;
          const [, prize, set, pos] = match;
          const key = 'G' + prize + '_' + set;
          if (!groups[key]) groups[key] = { prize: 'G' + prize, set, nums: [] };
          groups[key].nums[parseInt(pos) - 1] = parseInt($(el).text().trim());
        });
        const setsArr = Object.entries(groups)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, { prize, set, nums }]) => ({
            label: (PRIZE_LABELS[prize] || prize) + ' bộ ' + set,
            numbers: nums.filter(n => !isNaN(n)),
          }));
        if (setsArr.length === 0) return null;
        const titleText = $('div.title_tt').first().text();
        const kyveText = $('div.kyve').first().text();
        const kythuongText = $('div.kythuong').first().text();
        const periodText = $('span.period_live').first().text();
        const sourceText = titleText || kyveText || kythuongText || periodText;
        const urlDate = (url.match(/\/(\d{2})-(\d{2})-(\d{4})\.html/) || []).slice(1).join('/');
        const kySoParsed = sourceText.match(/#(\d+)/)?.[1] || '';
        const drawDateParsed = sourceText.match(/(\d{2})\/(\d{2})\/(\d{4})/)?.[0] || '';
        return {
          sets: setsArr,
          kySo: kySoParsed || (kysoTarget || ''),
          drawDate: drawDateParsed || urlDate || new Date().toLocaleDateString('vi-VN'),
        };
      }

      // Fallback ưu tiên cho trang lịch sử: parse từng block .boxLiveKQXS
      const drawsFromBlocks = [];
      $('.boxLiveKQXS').each((_, box) => {
        const boxEl = $(box);
        const boxCtx = boxEl.text().replace(/\s+/g, ' ').trim();
        if (!matchProductContext(boxCtx)) return;
        const kyText = boxEl.find('.kyve').first().text().replace(/\s+/g, ' ').trim();
        const kyMatch = kyText.match(/#(\d+)/);
        if (!kyMatch) return;
        const drawDateMatch = kyText.match(/(\d{2})\/(\d{2})\/(\d{4})/);
        const sets = [];
        const pushFromRow = (selector, labelPrefix) => {
          boxEl.find(selector).find('div').each((idx, divEl) => {
            const digits = $(divEl).find('span').map((__, sp) => parseInt($(sp).text().trim(), 10)).get()
              .filter((n) => !Number.isNaN(n) && n >= 0 && n <= 9);
            if (digits.length === 3) {
              sets.push({ label: labelPrefix + ' bộ ' + (idx + 1), numbers: digits });
            }
          });
        };
        pushFromRow('td.max3d_number.max3d_g1', 'Đặc biệt');
        pushFromRow('td.max3d_number.max3d_g2', 'Giải nhất');
        pushFromRow('td.max3d_number.max3d_g3', 'Giải nhì');
        // Có 2 hàng dùng class max3d_g2; hàng cuối là giải ba (nhiều bộ hơn)
        const allG2Rows = boxEl.find('td.max3d_number.max3d_g2');
        if (allG2Rows.length > 1) {
          $(allG2Rows[allG2Rows.length - 1]).find('div').each((idx, divEl) => {
            const digits = $(divEl).find('span').map((__, sp) => parseInt($(sp).text().trim(), 10)).get()
              .filter((n) => !Number.isNaN(n) && n >= 0 && n <= 9);
            if (digits.length === 3) {
              sets.push({ label: 'Giải ba bộ ' + (idx + 1), numbers: digits });
            }
          });
        }
        if (sets.length > 0) {
          drawsFromBlocks.push({
            ky: kyMatch[1],
            drawDate: drawDateMatch ? drawDateMatch[0] : '',
            sets,
          });
        }
      });

      if (drawsFromBlocks.length > 0) {
        const target = kysoTarget
          ? drawsFromBlocks.find((d) => d.ky === String(kysoTarget).replace(/^0+/, '') || d.ky === String(kysoTarget))
          : drawsFromBlocks[0];
        if (!target) return null;
        const urlDate = (url.match(/\/(\d{2})-(\d{2})-(\d{4})\.html/) || []).slice(1).join('/');
        return {
          sets: target.sets,
          kySo: target.ky || '',
          drawDate: target.drawDate || urlDate || new Date().toLocaleDateString('vi-VN'),
        };
      }

      // Fallback cho trang theo ngày: parse bảng "Kỳ vé #xxxx"
      const parsedDraws = [];
      $('table').each((_, tbl) => {
        const table = $(tbl);
        const tableText = table.text().replace(/\s+/g, ' ').trim();
        if (!/SỐ QUAY THƯỞNG/i.test(tableText) || !/MAX 3D/i.test(tableText)) return;
        let prev = table.prev();
        let ky = '';
        let drawDate = '';
        while (prev.length) {
          const t = prev.text().replace(/\s+/g, ' ').trim();
          const km = t.match(/Kỳ vé\s*#(\d+)/i);
          if (km) {
            ky = km[1];
            const dm = t.match(/(\d{2})\/(\d{2})\/(\d{4})/);
            if (dm) drawDate = dm[0];
            break;
          }
          prev = prev.prev();
        }
        if (!ky) return;

        const sets = parse3dSetsFromTable(table);

        if (sets.length > 0) {
          parsedDraws.push({ ky, drawDate, sets });
        }
      });

      // Fallback thêm: lấy ky/date từ text container gần table khi prev-sibling không có.
      if (parsedDraws.length === 0) {
        $('table').each((_, tbl) => {
          const table = $(tbl);
          const tableText = table.text().replace(/\s+/g, ' ').trim();
          if (!/SỐ QUAY THƯỞNG/i.test(tableText) || !/MAX 3D/i.test(tableText)) return;
          if (!matchProductContext(table.parent().text())) return;
          const ctxText = (table.parent().text() || '').replace(/\s+/g, ' ');
          const kyMatch = ctxText.match(/Kỳ vé\s*#(\d+)/i);
          if (!kyMatch) return;
          const dateMatch = ctxText.match(/(\d{2})\/(\d{2})\/(\d{4})/);
          const sets = parse3dSetsFromTable(table);
          if (sets.length > 0) {
            parsedDraws.push({
              ky: kyMatch[1],
              drawDate: dateMatch ? dateMatch[0] : '',
              sets,
            });
          }
        });
      }

      // Fallback cuối: tìm block quanh #kyso rồi parse table gần đó
      if (parsedDraws.length === 0) {
        const targetMark = kysoTarget ? ('#' + String(kysoTarget).replace(/^0+/, '')) : '';
        const htmlNorm = String(html || '').replace(/#0+/g, '#');
        const idx = targetMark ? htmlNorm.indexOf(targetMark) : -1;
        if (idx >= 0) {
          const start = Math.max(0, idx - 4000);
          const chunk = htmlNorm.slice(start, idx + 60000);
          const $$ = cheerio.load(chunk);
          const table = $$('table')
            .filter((__, t) => {
              const tx = $$(t).text().replace(/\s+/g, ' ').trim().toLowerCase();
              return tx.includes('so quay thuong') && (tx.includes('max 3d') || tx.includes('max3d'));
            })
            .first();
          const sets = [];
          table.find('tr').each((__, tr) => {
            const tds = $$(tr).find('td');
            if (tds.length < 2) return;
            const labelText = tds.eq(0).text().replace(/\s+/g, ' ').trim().toLowerCase();
            const numText = tds.eq(1).text().replace(/\s+/g, ' ').trim();
            const digits = numText.split(' ').map((x) => parseInt(x, 10)).filter((n) => !Number.isNaN(n) && n >= 0 && n <= 9);
            if (digits.length < 3) return;
            const push = (label, expected) => {
              const maxLen = Math.min(digits.length, expected * 3);
              let setNo = 1;
              for (let i = 0; i + 2 < maxLen; i += 3) {
                sets.push({ label: label + ' bộ ' + setNo, numbers: [digits[i], digits[i + 1], digits[i + 2]] });
                setNo++;
              }
            };
            if (labelText.includes('đặc biệt')) push('Đặc biệt', 2);
            else if (labelText.includes('giải nhất')) push('Giải nhất', 4);
            else if (labelText.includes('giải nhì')) push('Giải nhì', 6);
            else if (labelText.includes('giải ba')) push('Giải ba', 8);
          });
          if (sets.length > 0) {
            const kyInChunk = (chunk.match(/Kỳ vé\s*#(\d+)/i) || [])[1] || '';
            const normalizedTarget = String(kysoTarget || '').replace(/^0+/, '');
            const normalizedChunkKy = String(kyInChunk || '').replace(/^0+/, '');
            if (kysoTarget && (!normalizedChunkKy || normalizedChunkKy !== normalizedTarget)) {
              return null;
            }
            const dateMatch = chunk.match(/(\d{2})\/(\d{2})\/(\d{4})/);
            const urlDate = (url.match(/\/(\d{2})-(\d{2})-(\d{4})\.html/) || []).slice(1).join('/');
            return {
              sets,
              kySo: kyInChunk || '',
              drawDate: (dateMatch ? dateMatch[0] : '') || urlDate || new Date().toLocaleDateString('vi-VN'),
            };
          }
        }
        return null;
      }
      const targetDraw = kysoTarget
        ? parsedDraws.find((d) => d.ky === String(kysoTarget).replace(/^0+/, '') || d.ky === String(kysoTarget))
        : parsedDraws[0];
      const chosen = targetDraw || (!kysoTarget ? parsedDraws[0] : null);
      if (!chosen) return null;
      const urlDate = (url.match(/\/(\d{2})-(\d{2})-(\d{4})\.html/) || []).slice(1).join('/');
      return {
        sets: chosen.sets,
        kySo: chosen.ky || '',
        drawDate: chosen.drawDate || urlDate || new Date().toLocaleDateString('vi-VN'),
      };
    }

    // LOTTO535
    if (product === 'lotto535') {
      const allKys = [];

      // Trang theo ngày có nhiều title_tt (21h trước, 13h sau)
      $('div.title_tt').each((_, titleEl) => {
        const titleText = $(titleEl).text();
        const kyMatch = titleText.match(/#(\d+)/);
        if (!kyMatch) return;

        const parent = $(titleEl).parent();
        const nums = [];
        let power = null;
        parent.find('span.ball_lotto').each((_, el) => {
          const cls = $(el).attr('class') || '';
          const n = parseInt($(el).text().trim());
          if (isNaN(n)) return;
          if (cls.includes('ball_power2')) power = n;
          else nums.push(n);
        });
        if (nums.length > 0) {
          allKys.push({
            ky: kyMatch[1],
            numbers: nums.slice(0, 5),
            powerNumber: power,
            drawDate: titleText.match(/(\d{2})\/(\d{2})\/(\d{4})/)?.[0] || '',
          });
        }
      });

      // Trang trực tiếp chỉ có 1 kỳ, fallback từ toàn trang
      if (allKys.length === 0) {
        let kySo = '';
        let drawDate = '';
        const els = ['span.period_live', 'div.kyve', 'div.kythuong'];
        for (const sel of els) {
          const text = $(sel).first().text();
          const kyMatch = text.match(/#(\d+)/);
          const dateMatch = text.match(/(\d{2})\/(\d{2})\/(\d{4})/);
          if (kyMatch) kySo = kyMatch[1];
          if (dateMatch) drawDate = dateMatch[0];
          if (kySo) break;
        }
        if (!drawDate) drawDate = new Date().toLocaleDateString('vi-VN');

        const numbers = [];
        let powerNumber = null;
        $('span.ball_lotto').each((_, el) => {
          const cls = $(el).attr('class') || '';
          const n = parseInt($(el).text().trim());
          if (isNaN(n)) return;
          if (cls.includes('ball_power2')) powerNumber = n;
          else numbers.push(n);
        });
        if (numbers.length === 0) return null;
        allKys.push({
          ky: kySo || '',
          numbers: numbers.slice(0, 5),
          powerNumber,
          drawDate,
        });
      }

      const targetKyNum = kysoTarget ? parseInt(kysoTarget) : null;
      let target = null;

      if (targetKyNum) {
        // Tìm chính xác theo kySo
        target = allKys.find(k => k.ky === kysoTarget);

        // Nếu không tìm thấy theo ky label → dùng index
        if (!target && allKys.length > 0) {
          // Kỳ lẻ → index 1 (kỳ 13h), kỳ chẵn → index 0 (kỳ 21h)
          const isOdd = targetKyNum % 2 === 1;
          target = isOdd ? allKys[1] : allKys[0];
          if (target) target = { ...target, ky: kysoTarget };
        }
      } else {
        target = allKys[0];
      }

      if (!target) return null;
      return {
        numbers: target.numbers,
        powerNumber: target.powerNumber,
        kySo: target.ky,
        drawDate: target.drawDate,
      };
    }

    // KENO (hỗ trợ chọn kỳ quá khứ theo trang kết quả ngày)
    if (product === 'keno' && kysoTarget) {
      const normalizedKy = String(kysoTarget).replace(/^0+/, '');
      const htmlNorm = String(html || '').replace(/#0+/g, '#');
      const idx = htmlNorm.indexOf('#' + normalizedKy);
      if (idx >= 0) {
        const start = Math.max(0, idx - 6000);
        const chunk = htmlNorm.slice(start, idx + 40000);
        const $$ = cheerio.load(chunk);
        const nums = $$('span.ball_keno, span.ball.ball_keno, span[class*="ball_keno"]')
          .map((_, el) => parseInt($$(el).text().trim(), 10))
          .get()
          .filter((n) => !Number.isNaN(n) && n >= 1);
        const unique = [...new Set(nums)].slice(0, 20);
        if (unique.length >= 10) {
          const drawDate = (chunk.match(/(\d{2})\/(\d{2})\/(\d{4})/) || [])[0] || '';
          return {
            numbers: unique,
            powerNumber: null,
            kySo: String(kysoTarget),
            drawDate,
          };
        }
      }
      return null;
    }

    // MEGA, POWER, KENO
    const selectorMap = {
      mega:     'span.ball_orange, span.ball.ball_orange',
      power:    'span.ball_power, span.ball.ball_power',
      keno:     'span.ball_keno, span.ball.ball_keno',
    };

    const numbers = [];
    let powerNumber = null;

    $(selectorMap[product] || 'span[class*="ball"]').each((_, el) => {
      const n = parseInt($(el).text().trim());
      if (!isNaN(n) && n >= 1) numbers.push(n);
    });

    if (product === 'power') {
      const powerEl = $('span.ball_power2, span.ball.ball_power2').first();
      if (powerEl.length) powerNumber = parseInt(powerEl.text().trim());
    }

    const maxMap = { keno: 20, lotto535: 5, mega: 6, power: 6 };
    const uniqueNums = [...new Set(numbers)].slice(0, maxMap[product] || 6);
    if (uniqueNums.length === 0) return null;

    const titleText = $('div.title_tt').first().text();
    const kythuong = $('div.kythuong').first().text();
    const kyve = $('div.kyve').first().text();

    const sourceText = titleText || kythuong || kyve;
    const kySo = sourceText.match(/#(\d+)/)?.[1] ||
                 $('span.period_live').first().text().replace(/[^0-9]/g, '') ||
                 $('span#cur_ky').first().text().replace(/[^0-9]/g, '') || '';
    const drawDate = sourceText.match(/(\d{2})\/(\d{2})\/(\d{4})/)?.[0] || '';

    return { numbers: uniqueNums, powerNumber, kySo, drawDate };
  } catch(e) {
    console.log('[scrapeWithAxios] failed:', e.message, e.stack?.slice(0,200));
    return null;
  }
}

function parseVietlottByCheerio(product, html) {
  const $ = cheerio.load(html);
  const bodyText = $('body').text() || '';

  const titleText = $('div.title_tt').first().text() || '';
  const headerText = $('div.kythuong, div.kyve').first().text() || '';
  const kySo =
    ($('span.period_live').first().text() || '').replace(/[^0-9]/g, '') ||
    ($('span#cur_ky').first().text() || '').replace(/[^0-9]/g, '') ||
    ((titleText.match(/#(\d+)/) || [])[1] || '') ||
    ((headerText.match(/#(\d+)/) || [])[1] || '');

  const drawDate =
    ((titleText.match(/(\d{2})\/(\d{2})\/(\d{4})/) || [])[0]) ||
    ((headerText.match(/(\d{2})\/(\d{2})\/(\d{4})/) || [])[0]) ||
    ((bodyText.match(/(\d{2})\/(\d{2})\/(\d{4})/) || [])[0]) ||
    new Date().toLocaleDateString('vi-VN');

  if (product === 'max3d' || product === 'max3dpro') {
    const groups = {};
    $('span[id^="max3d_G"]').each((_, el) => {
      const id = ($(el).attr('id') || '').trim();
      const match = id.match(/max3d_G(\d+)_(\d+)_(\d+)/);
      if (!match) return;
      const [, prize, set, pos] = match;
      const key = 'G' + prize + '_' + set;
      if (!groups[key]) groups[key] = { prize: 'G' + prize, set, nums: [] };
      const num = parseInt($(el).text().trim(), 10);
      if (!isNaN(num)) groups[key].nums[parseInt(pos, 10) - 1] = num;
    });

    const sets = Object.entries(groups)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, { prize, set, nums }]) => ({
        label: (PRIZE_LABELS[prize] || prize) + ' bộ ' + set,
        numbers: nums.filter((n) => !isNaN(n)),
      }))
      .filter((x) => x.numbers.length > 0);

    if (sets.length === 0) return null;
    return { sets, drawDate, kySo };
  }

  const selectorMap = {
    mega: 'span.ball_orange, span.ball.ball_orange',
    power: 'span.ball_power, span.ball.ball_power',
    keno: 'span.ball_keno, span.ball.ball_keno',
    lotto535: 'span.ball_lotto:not(.ball_power2)',
    max3d: 'span[id^="max3d_G"]',
  };
  const selector = selectorMap[product] || 'span[class*="ball"]';
  const numbers = $(selector)
    .map((_, el) => parseInt($(el).text().trim(), 10))
    .get()
    .filter((n) => !isNaN(n) && n >= 1);

  if (numbers.length === 0) return null;

  let powerNumber = null;
  if (product === 'lotto535' || product === 'power') {
    const powerText = $('span.ball_lotto.ball_power2, span.ball.ball_lotto.ball_power2, span.ball_power2, span.ball.ball_power2')
      .first()
      .text()
      .trim();
    const parsedPower = parseInt(powerText, 10);
    powerNumber = isNaN(parsedPower) ? null : parsedPower;
  }

  const maxMap = { keno: 20, lotto535: 5, mega: 6, power: 6 };
  return {
    numbers: [...new Set(numbers)].slice(0, maxMap[product] || 6),
    powerNumber,
    kySo,
    drawDate,
  };
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
  if (!VIETLOTT_PRODUCT_IDS.includes(product) || !VL_URLS[product]) {
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
    if (detailUrl) tryUrls.push(detailUrl);
    const listUrl = buildVietlottListingUrl(product);
    if (listUrl && !tryUrls.includes(listUrl)) tryUrls.push(listUrl);
  }

  if (VL_URLS[product] && !tryUrls.includes(VL_URLS[product])) {
    tryUrls.push(VL_URLS[product]);
  }
  if (!kyso && info?.currentDate && BASE_URL_MAP[product]) {
    const parts = info.currentDate.split('/');
    if (parts.length === 3) {
      const [dd, mm, yyyy] = parts;
      const dated = 'https://www.ketquadientoan.com/' + BASE_URL_MAP[product] + '/' + dd + '-' + mm + '-' + yyyy + '.html';
      if (!tryUrls.includes(dated)) tryUrls.push(dated);
    }
  }
  if (tryUrls.length === 0 && VL_URLS[product]) tryUrls.push(VL_URLS[product]);
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

  // Thử axios: lần lượt vietlott → ketquadientoan (theo tryUrls).
  if (axiosResult) {
    if ((product === 'max3d' || product === 'max3dpro') && kyso && !axiosResult.kySo) {
      axiosResult.kySo = kyso;
    }
    if ((product === 'max3d' || product === 'max3dpro') && !axiosResult.drawDate) {
      const m = url.match(/\/(\d{2})-(\d{2})-(\d{4})\.html/);
      if (m) axiosResult.drawDate = m[1] + '/' + m[2] + '/' + m[3];
      if (!axiosResult.drawDate && String(url).includes('vietlott.vn')) {
        axiosResult.drawDate = new Date().toLocaleDateString('vi-VN');
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
  if ((product === 'max3d' || product === 'max3dpro') && kyso) {
    throw new Error('Không parse được dữ liệu 3D từ trang theo ngày cho kỳ ' + kyso);
  }
  console.log('[' + product + '] axios failed, trying puppeteer');

  return withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    let opened = false;
    let gotoErr = null;
    for (const u of tryUrls) {
      if (!u) continue;
      try {
        await page.goto(u, { waitUntil: 'networkidle2', timeout: 60000 });
        url = u;
        opened = true;
        break;
      } catch (e) {
        gotoErr = e;
      }
    }
    if (!opened) throw gotoErr || new Error('Không mở được trang kết quả');
    await new Promise(r => setTimeout(r, 5000));

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
        return new Date().toLocaleDateString('vi-VN');
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

    // KENO — scrape theo kyso từ trang tra cứu
    if (product === 'keno' && kyso) {
      const numbers = await page.evaluate(() => {
        const balls = document.querySelectorAll('span.ball_keno, span.ball.ball_keno');
        return Array.from(balls).map(e => parseInt(e.textContent.trim())).filter(n => !isNaN(n) && n >= 1);
      });

      const kySoParsed = await page.evaluate(() => {
        const el = document.querySelector('span#cur_ky, div.kythuong span');
        return el ? el.textContent.trim().replace(/[^0-9]/g, '') : '';
      });

      const result = {
        numbers: [...new Set(numbers)].slice(0, 20),
        kySo: kySoParsed,
        drawDate: new Date().toLocaleDateString('vi-VN'),
      };
      if (result.numbers.length === 0) throw new Error('Không tìm thấy số kết quả Keno');
      const rk = padVietlottId('keno', result.kySo || kyso || '');
      if (rk) result.kySo = rk;
      setCache(cacheKey, result);
      await saveVietlottToSupabase('keno', rk || result.kySo || kyso, result);
      return result;
    }

    // MEGA, POWER, LOTTO535
    const numbers = await page.evaluate((prod) => {
      const maps = {
        mega:     'span.ball_orange, span.ball.ball_orange',
        power:    'span.ball_power, span.ball.ball_power',
        keno:     'span.ball_keno, span.ball.ball_keno',
        lotto535: 'span.ball_lotto',
      };
      const sel = maps[prod] || 'span[class*="ball"]';
      const els = document.querySelectorAll(sel);
      return Array.from(els).map(e => parseInt(e.textContent.trim())).filter(n => !isNaN(n) && n >= 1);
    }, product);

    let powerNumber = null;
    if (product === 'lotto535' || product === 'power') {
      powerNumber = await page.evaluate(() => {
        const el = document.querySelector(
          'span.ball_lotto.ball_power2, span.ball.ball_lotto.ball_power2, span.ball_power2, span.ball.ball_power2'
        );
        return el ? parseInt(el.textContent.trim()) : null;
      });
    }

    const kySo = await page.evaluate(() => {
      const periodEl = document.querySelector('span.period_live');
      if (periodEl) return periodEl.textContent.trim().replace(/[^0-9]/g, '');
      const curKy = document.querySelector('span#cur_ky');
      if (curKy) return curKy.textContent.trim().replace(/[^0-9]/g, '');
      const allTitleTt = document.querySelectorAll('div.title_tt');
      if (allTitleTt.length > 0) {
        const m = allTitleTt[0].textContent.match(/#(\d+)/);
        if (m) return m[1];
      }
      return '';
    });

    const drawDate = await page.evaluate(() => {
      // Trang theo ngày: div.title_tt đầu tiên
      const allTitleTt = document.querySelectorAll('div.title_tt');
      if (allTitleTt.length > 0) {
        const m = allTitleTt[0].textContent.match(/(\d{2})\/(\d{2})\/(\d{4})/);
        if (m) return m[0];
      }
      // Trang trực tiếp: div.kythuong hoặc div.kyve
      const kythuong = document.querySelector('div.kythuong, div.kyve');
      if (kythuong) {
        const m = kythuong.textContent.match(/(\d{2})\/(\d{2})\/(\d{4})/);
        if (m) return m[0];
      }
      const m = document.body.innerText.match(/(\d{2})\/(\d{2})\/(\d{4})/);
      return m ? m[0] : new Date().toLocaleDateString('vi-VN');
    });

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

// Scrape Keno theo kyso — dùng trang tra cứu
async function scrapeKenoByKySo(kyso) {
  const cacheKey = 'vl_keno_' + kyso;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const officialUrl = buildVietlottDetailUrl('keno', padVietlottId('keno', kyso));
  if (officialUrl) {
    const parsedOfficial = await scrapeWithAxios(officialUrl, 'keno', String(kyso));
    if (parsedOfficial && Array.isArray(parsedOfficial.numbers) && parsedOfficial.numbers.length >= 10) {
      if (!parsedOfficial.drawDate) parsedOfficial.drawDate = new Date().toLocaleDateString('vi-VN');
      setCache(cacheKey, parsedOfficial);
      return parsedOfficial;
    }
  }

  const kenoListUrl = buildVietlottListingUrl('keno');
  if (kenoListUrl) {
    const parsedList = await scrapeWithAxios(kenoListUrl, 'keno', String(kyso));
    if (parsedList && Array.isArray(parsedList.numbers) && parsedList.numbers.length > 0) {
      if (!parsedList.drawDate) parsedList.drawDate = new Date().toLocaleDateString('vi-VN');
      setCache(cacheKey, parsedList);
      return parsedList;
    }
  }

  // Trang live ketquadientoan (nhiều kỳ gần đây).
  const parsedLive = await scrapeWithAxios(VL_URLS.keno, 'keno', String(kyso));
  if (parsedLive && Array.isArray(parsedLive.numbers) && parsedLive.numbers.length > 0) {
    if (!parsedLive.drawDate) parsedLive.drawDate = new Date().toLocaleDateString('vi-VN');
    setCache(cacheKey, parsedLive);
    return parsedLive;
  }

  // Fallback: nếu không thấy trên trang live thì thử trang theo ngày, nhưng giới hạn lookback để tránh timeout dài.
  const directUrl = await findDateUrlByKySo('keno', String(kyso), 5);
  if (directUrl) {
    const parsed = await scrapeWithAxios(directUrl, 'keno', String(kyso));
    if (parsed && Array.isArray(parsed.numbers) && parsed.numbers.length > 0) {
      if (!parsed.drawDate) {
        const m = directUrl.match(/\/(\d{2})-(\d{2})-(\d{4})\.html/);
        if (m) parsed.drawDate = m[1] + '/' + m[2] + '/' + m[3];
      }
      setCache(cacheKey, parsed);
      return parsed;
    }
  }

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
        drawDate: new Date().toLocaleDateString('vi-VN'),
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
            drawDate: new Date().toLocaleDateString('vi-VN'),
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
  const drawDateKey = dateStr || new Date().toLocaleDateString('vi-VN');

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
    'https://www.ketquadientoan.com/truc-tiep-xo-so-dien-toan-lotto-535.html',
    'https://www.minhngoc.net.vn/',
    'https://xoso.com.vn/',
  ];

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
    const url = 'https://www.ketquadientoan.com/truc-tiep-xo-so-dien-toan-lotto-535.html';
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

    const supported = Object.keys(VL_URLS);
    if (!supported.includes(product)) {
      return res.status(400).json({ success: false, error: 'Product không hợp lệ', supported });
    }

    const currentInfo = await getCurrentInfo(product);
    let resolvedUrl = buildVietlottListingUrl(product) || VL_URLS[product];
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
  Object.keys(VL_URLS).forEach((p) => scrapeVietlott(p, null).catch(() => {}));
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log('✅ Doxoso API server chạy tại http://localhost:' + PORT);
  console.log('✅ Mobile access: http://172.20.10.12:' + PORT);
});