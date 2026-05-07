const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const cron = require('node-cron');
const axios = require('axios');
const cheerio = require('cheerio');

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

const VL_URLS = {
  mega:     'https://www.ketquadientoan.com/truc-tiep-xo-so-dien-toan-mega-6-45.html',
  power:    'https://www.ketquadientoan.com/truc-tiep-xo-so-dien-toan-power-655.html',
  keno:     'https://www.ketquadientoan.com/truc-tiep-xo-so-dien-toan-keno.html',
  max3d:    'https://www.ketquadientoan.com/truc-tiep-xo-so-dien-toan-max-3d.html',
  max3dpro: 'https://www.ketquadientoan.com/truc-tiep-xo-so-dien-toan-max3d-pro.html',
  lotto535: 'https://www.ketquadientoan.com/truc-tiep-xo-so-dien-toan-lotto-535.html',
};

const BASE_URL_MAP = {
  mega:     'ket-qua-xo-so-dien-toan-mega-6-45',
  power:    'ket-qua-xo-so-dien-toan-power-655',
  keno:     'ket-qua-xo-so-dien-toan-keno',
  max3d:    'ket-qua-xo-so-dien-toan-max-3d',
  max3dpro: 'ket-qua-xo-so-dien-toan-max3d-pro',
  lotto535: 'ket-qua-xo-so-dien-toan-lotto-5-35',
};

const DRAW_DAYS = {
  mega:     [0, 3, 5],
  power:    [2, 4, 6],
  max3d:    [1, 3, 5],
  max3dpro: [1, 3, 5],
  lotto535: [0,1,2,3,4,5,6],
  keno:     [0,1,2,3,4,5,6],
};

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

  const url = VL_URLS[product];
  if (!url) return { currentKy: '', currentDate: '' };

  try {
    const { data: html } = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'vi-VN,vi;q=0.9',
      },
      timeout: 15000,
    });

    const $ = cheerio.load(html);
    let currentKy = '';
    let currentDate = '';

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

    const info = { currentKy, currentDate };
    cache[cacheKey] = { data: info, timestamp: Date.now() };
    return info;
  } catch (e) {
    console.warn('[getCurrentInfo ' + product + '] axios error:', e.message);
    return { currentKy: '', currentDate: '' };
  }
}

// Tính URL từ kyso
async function getUrlFromKySo(product, kyso) {
  const info = await getCurrentInfo(product);
  if (!info.currentKy || !info.currentDate) return VL_URLS[product];

  const currentKyNum = parseInt(info.currentKy);
  const targetKyNum = parseInt(kyso);
  const diff = currentKyNum - targetKyNum;

  if (diff <= 0) return VL_URLS[product]; // kỳ hiện tại

  const drawDays = DRAW_DAYS[product] || [0,1,2,3,4,5,6];
  const [dd, mm, yyyy] = info.currentDate.split('/');
  let current = new Date(parseInt(yyyy), parseInt(mm)-1, parseInt(dd));
  let count = 0;
  while (count < diff) {
    current.setDate(current.getDate() - 1);
    if (drawDays.includes(current.getDay())) count++;
  }
  const newDd = String(current.getDate()).padStart(2, '0');
  const newMm = String(current.getMonth() + 1).padStart(2, '0');
  const newYyyy = current.getFullYear();
  const dateStr = newDd + '-' + newMm + '-' + newYyyy;
  const url = 'https://www.ketquadientoan.com/' + BASE_URL_MAP[product] + '/' + dateStr + '.html';
  console.log('[getUrlFromKySo] ' + product + ' kyso=' + kyso + ' diff=' + diff + ' → ' + url);
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

async function scrapeVietlott(product, kyso) {
  const cacheKey = 'vl_' + product + (kyso ? '_' + kyso : '');
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const url = kyso ? await getUrlFromKySo(product, kyso) : VL_URLS[product];
  if (!url) throw new Error('Unknown product: ' + product);

  const html = await fetchHTML(url);
  console.log('[axios ' + product + '] HTML length:', html?.length);
  console.log('[axios ' + product + '] has ball_power:', html?.includes('ball_power'));
  console.log('[axios ' + product + '] has ball_orange:', html?.includes('ball_orange'));
  if (html) {
    const quickResult = parseVietlottByCheerio(product, html);
    if (quickResult) {
      console.log('[' + product + '] using axios+cheerio');
      setCache(cacheKey, quickResult);
      return quickResult;
    }
  }

  return withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
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
      setCache(cacheKey, result);
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
      setCache(cacheKey, result);
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
    setCache(cacheKey, result);
    return result;
  });
}

// Scrape Keno theo kyso — dùng trang tra cứu
async function scrapeKenoByKySo(kyso) {
  const cacheKey = 'vl_keno_' + kyso;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  return withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    // Trang tra cứu Keno có form search theo kỳ
    await page.goto('https://www.ketquadientoan.com/ket-qua-xo-so-dien-toan-keno.html', {
      waitUntil: 'networkidle2', timeout: 60000,
    });
    await new Promise(r => setTimeout(r, 3000));

    // Nhập kỳ số vào form search
    await page.evaluate((ky) => {
      const input = document.querySelector('input[name="kyso"], input#kyso, input.kyso');
      if (input) { input.value = ky; input.dispatchEvent(new Event('change')); }
    }, kyso);

    // Submit form
    await page.evaluate(() => {
      const btn = document.querySelector('button[type="submit"], input[type="submit"], .btn-search, .btn-timkiem');
      if (btn) btn.click();
    });

    await new Promise(r => setTimeout(r, 3000));

    const data = await page.evaluate(() => {
      // Tìm row có kỳ số matching trong bảng kết quả
      const rows = document.querySelectorAll('tr, .row-keno, .keno-row');
      const results = [];
      rows.forEach(row => {
        const kyEl = row.querySelector('.ky-xo, td:first-child, [class*="ky"]');
        const balls = row.querySelectorAll('span.ball_keno, span[class*="ball"]');
        if (balls.length >= 10) {
          results.push({
            ky: kyEl ? kyEl.textContent.trim() : '',
            numbers: Array.from(balls).map(b => parseInt(b.textContent.trim())).filter(n => !isNaN(n)),
          });
        }
      });
      return results.slice(0, 5);
    });

    console.log('[keno kyso=' + kyso + '] data:', JSON.stringify(data));

    // Tìm kỳ matching
    const matched = data.find(r => r.ky.includes(kyso));
    if (!matched || matched.numbers.length === 0) {
      throw new Error('Không tìm thấy kỳ Keno ' + kyso);
    }

    const result = {
      numbers: matched.numbers.slice(0, 20),
      kySo: kyso,
      drawDate: new Date().toLocaleDateString('vi-VN'),
    };
    setCache(cacheKey, result);
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
  let allResults = await scrapeAllXSKT(dateStr, preferredRegion);
  const keys = Object.keys(allResults);

  function norm(s) {
    return s.toLowerCase()
      .replace('tp. hồ chí minh', 'tp. hcm')
      .replace('hồ chí minh', 'hcm')
      .replace(/\s+/g, ' ').trim();
  }

  const normDai = norm(dai);
  if (allResults[dai]) return allResults[dai];
  let found = keys.find(k => norm(k) === normDai || norm(k).includes(normDai) || normDai.includes(norm(k)));
  if (found) return allResults[found];

  // Fallback: thử các miền còn lại nếu không match ở miền ưu tiên
  for (const r of ['mb', 'mt', 'mn']) {
    if (r === preferredRegion) continue;
    allResults = await scrapeAllXSKT(dateStr, r);
    const otherKeys = Object.keys(allResults);
    if (allResults[dai]) return allResults[dai];
    found = otherKeys.find(k => norm(k) === normDai || norm(k).includes(normDai) || normDai.includes(norm(k)));
    if (found) return allResults[found];
  }

  console.warn('[XSKT] Không tìm thấy:', dai, '| Có:', keys);
  throw new Error('Đài ' + dai + ' chưa có kết quả hôm nay');
}

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

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

app.get('/vietlott/keno/by-kyso', async (req, res) => {
  const { kyso } = req.query;
  if (!kyso) return res.status(400).json({ success: false, error: 'Thiếu kyso' });
  try {
    const result = await scrapeKenoByKySo(kyso);
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
  Object.keys(VL_URLS).forEach(p => scrapeVietlott(p, null).catch(() => {}));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log('✅ Doxoso API server chạy tại http://localhost:' + PORT);
  console.log('✅ Mobile access: http://172.20.10.12:' + PORT);
});