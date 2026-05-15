'use strict';

const { createWorker } = require('tesseract.js');
const {
  matchDai,
  normalizeDrawDateVi,
  postProcessParsed,
} = require('./scan-vision');

const DAI_LIST = [
  'TP. Hồ Chí Minh',
  'TP.HCM',
  'Đồng Nai',
  'Bình Dương',
  'Vũng Tàu',
  'Long An',
  'Tiền Giang',
  'Bến Tre',
  'Đồng Tháp',
  'Cà Mau',
  'An Giang',
  'Kiên Giang',
  'Cần Thơ',
  'Hậu Giang',
  'Sóc Trăng',
  'Bạc Liêu',
  'Trà Vinh',
  'Vĩnh Long',
  'Tây Ninh',
  'Bình Thuận',
  'Bình Phước',
  'Đà Nẵng',
  'Khánh Hòa',
  'Thừa Thiên Huế',
  'Huế',
  'Quảng Nam',
  'Bình Định',
  'Phú Yên',
  'Quảng Ngãi',
  'Quảng Trị',
  'Quảng Bình',
  'Ninh Thuận',
  'Gia Lai',
  'Đắk Lắk',
  'Đắk Nông',
  'Kon Tum',
  'Hà Nội',
  'Hải Phòng',
  'Quảng Ninh',
  'Bắc Ninh',
  'Nam Định',
  'Thái Bình',
  'Đà Lạt',
  'Miền Bắc',
];

const MB_DAI = ['Hà Nội', 'Hải Phòng', 'Quảng Ninh', 'Bắc Ninh', 'Nam Định', 'Thái Bình'];

let workerPromise = null;

function ocrEnabled() {
  const v = process.env.SCAN_OCR_ENABLED;
  if (v === '0' || v === 'false') return false;
  return true;
}

function minConfidence() {
  const n = parseFloat(process.env.SCAN_OCR_MIN_CONFIDENCE || '0.35');
  return Number.isFinite(n) ? n : 0.35;
}

function normDaiKey(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\./g, '')
    .trim();
}

function isMienBacDai(dai) {
  const n = normDaiKey(dai);
  if (n.includes('mien bac') || n === 'mb') return true;
  return MB_DAI.some((d) => normDaiKey(d) === n);
}

function getConfidence(text) {
  const t = String(text || '');
  let score = 0;
  if (/\d{5,6}/.test(t)) score += 0.45;
  if (/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(t)) score += 0.15;
  if (t.trim().length > 12) score += 0.2;
  if (/mega|power|keno|max\s*3d|lotto|vietlott|xskt|kien thiet|xo so/i.test(t)) score += 0.2;
  return Math.min(score, 1);
}

function extractDrawDateFromText(text) {
  const t = String(text || '');
  let m = t.match(/(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
  if (m) return normalizeDrawDateVi(m[0]);
  m = t.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return normalizeDrawDateVi(m[0]);
  return '';
}

function findDaiInText(text) {
  const normalizedText = String(text || '').toLowerCase();
  for (const d of DAI_LIST) {
    const key = d.toLowerCase().replace(/\./g, '');
    if (normalizedText.includes(key) || normalizedText.includes(d.toLowerCase())) {
      if (d === 'TP.HCM') return 'TP. Hồ Chí Minh';
      if (d === 'Huế') return 'Thừa Thiên Huế';
      return d;
    }
  }
  if (/mien\s*bac|miền\s*bắc|\bmb\b/i.test(text)) return 'Miền Bắc';
  return '';
}

function parseVietlottFromText(raw) {
  const text = String(raw || '');
  if (!text.trim()) return { type: 'unknown' };

  try {
    const data = JSON.parse(text);
    if (data.numbers || data.nums) {
      return {
        type: 'vietlott',
        product: String(data.product || 'mega').toLowerCase(),
        numbers: (data.numbers || data.nums)
          .map((n) => parseInt(String(n).replace(/\D/g, ''), 10))
          .filter((n) => !Number.isNaN(n)),
      };
    }
  } catch (_e) {
    /* not JSON */
  }

  const parts = text.split('|');
  if (parts.length >= 3) {
    const numbers = parts[2]
      .split(/[,;\s]+/)
      .map((s) => parseInt(String(s).trim(), 10))
      .filter((n) => !Number.isNaN(n));
    if (numbers.length >= 3) {
      return {
        type: 'vietlott',
        product: String(parts[0] || 'mega').toLowerCase().replace(/\s+/g, ''),
        numbers,
      };
    }
  }

  const lower = text.toLowerCase();
  const nums = (text.match(/\b\d{1,2}\b/g) || [])
    .map((s) => Number(s))
    .filter((n) => n >= 0 && n <= 80);

  if (/keno/i.test(lower)) return { type: 'vietlott', product: 'keno', numbers: nums.slice(0, 10) };
  if (/mega|6\s*\/\s*45/i.test(lower)) return { type: 'vietlott', product: 'mega', numbers: nums.slice(0, 6) };
  if (/power|6\s*\/\s*55|655/i.test(lower)) return { type: 'vietlott', product: 'power', numbers: nums.slice(0, 6) };
  if (/max\s*3d\s*pro|max3dpro|3d\s*pro/i.test(lower)) return { type: 'vietlott', product: 'max3dpro', numbers: nums.slice(0, 6) };
  if (/max\s*3d|max3d/i.test(lower)) return { type: 'vietlott', product: 'max3d', numbers: nums.slice(0, 3) };
  if (/lotto|5\s*\/\s*35|535/i.test(lower)) return { type: 'vietlott', product: 'lotto535', numbers: nums.slice(0, 6) };

  const pairMatches = text.match(/\b([0-9]{2})\b/g);
  if (pairMatches && pairMatches.length >= 6) {
    return {
      type: 'vietlott',
      product: 'mega',
      numbers: pairMatches.slice(0, 6).map(Number),
    };
  }

  return { type: 'unknown' };
}

function parseXsktFromText(text) {
  const compactDigits = String(text || '').replace(/\D/g, '');
  const foundDai = findDaiInText(text);
  const daiNorm = foundDai ? matchDai(foundDai) || foundDai : '';
  const mb = daiNorm ? isMienBacDai(daiNorm) : /mien\s*bac|miền\s*bắc/i.test(text);

  let ticket = '';
  if (mb) {
    const m5 = compactDigits.match(/(\d{5})/);
    if (m5) ticket = m5[1];
    if (ticket.length === 5) {
      return { type: 'xskt', ticketNumber: ticket, dai: daiNorm || 'Miền Bắc' };
    }
  }

  const matches = compactDigits.match(/\d{6}/g);
  if (matches && matches.length) ticket = matches[matches.length - 1];
  if (ticket.length === 6) {
    return { type: 'xskt', ticketNumber: ticket, dai: daiNorm || undefined };
  }
  return { type: 'unknown' };
}

function parseOCRCombined(text, channel) {
  const t = String(text || '')
    .replace(/\r/g, '\n')
    .trim();
  if (!t) return { type: 'unknown' };

  const tryOrder =
    channel === 'vietlott'
      ? ['vietlott', 'xskt']
      : channel === 'xskt'
        ? ['xskt', 'vietlott']
        : ['xskt', 'vietlott'];

  for (const kind of tryOrder) {
    if (kind === 'xskt') {
      const xs = parseXsktFromText(t);
      if (xs.type === 'xskt') return xs;
    } else {
      const vl = parseVietlottFromText(t);
      if (vl.type === 'vietlott') return vl;
    }
  }
  return { type: 'unknown' };
}

function rawParseToData(raw, channel) {
  const parsed = parseOCRCombined(raw.text, channel);
  if (parsed.type === 'unknown') return null;

  const drawDate = extractDrawDateFromText(raw.text);
  if (parsed.type === 'xskt') {
    return postProcessParsed(
      {
        type: 'xskt',
        dai: parsed.dai,
        drawDate,
        ticketNumber: parsed.ticketNumber,
      },
      'xskt'
    );
  }

  return postProcessParsed(
    {
      type: 'vietlott',
      product: parsed.product,
      numbers: parsed.numbers,
      drawDate,
    },
    'vietlott'
  );
}

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const worker = await createWorker('vie+eng');
      return worker;
    })().catch((e) => {
      workerPromise = null;
      throw e;
    });
  }
  return workerPromise;
}

/**
 * @param {Buffer} imageBuffer
 * @param {string} channel xskt | vietlott | auto
 * @returns {Promise<{ ok: boolean, data?: object, text?: string, confidence?: number, ms?: number, error?: string }>}
 */
async function tryScanWithOcr(imageBuffer, channel) {
  if (!ocrEnabled()) {
    return { ok: false, error: 'OCR disabled' };
  }
  if (!imageBuffer || !imageBuffer.length) {
    return { ok: false, error: 'empty image' };
  }

  const started = Date.now();
  const ch =
    channel === 'vietlott' ? 'vietlott' : channel === 'auto' ? 'auto' : 'xskt';

  try {
    const worker = await getWorker();
    const { data } = await worker.recognize(imageBuffer);
    const text = (data && data.text) || '';
    const confidence = getConfidence(text);
    const minConf = minConfidence();

    if (confidence < minConf) {
      return {
        ok: false,
        text: text.slice(0, 400),
        confidence,
        ms: Date.now() - started,
        error: 'OCR confidence too low',
      };
    }

    const shaped = rawParseToData({ text }, ch);
    if (!shaped || shaped.type === 'unknown') {
      return {
        ok: false,
        text: text.slice(0, 400),
        confidence,
        ms: Date.now() - started,
        error: 'OCR parse failed',
      };
    }

    return {
      ok: true,
      data: shaped,
      text: text.slice(0, 400),
      confidence,
      ms: Date.now() - started,
    };
  } catch (e) {
    return {
      ok: false,
      ms: Date.now() - started,
      error: e.message || 'OCR error',
    };
  }
}

function getOcrConfig() {
  return {
    enabled: ocrEnabled(),
    minConfidence: minConfidence(),
    workerReady: !!workerPromise,
  };
}

module.exports = {
  tryScanWithOcr,
  getOcrConfig,
  parseOCRCombined,
  getConfidence,
};
