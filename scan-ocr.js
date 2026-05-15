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
  const n = parseFloat(process.env.SCAN_OCR_MIN_CONFIDENCE || '0.48');
  return Number.isFinite(n) ? n : 0.48;
}

function strictOcrParse() {
  const v = process.env.SCAN_OCR_STRICT;
  if (v === '0' || v === 'false') return false;
  return true;
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

function getConfidence(text, tesseractConf) {
  const t = String(text || '');
  let score = 0;
  if (/\b\d{6}\b/.test(t) || /\b\d{5}\b/.test(t)) score += 0.35;
  if (/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(t)) score += 0.1;
  if (t.trim().length > 20) score += 0.15;
  if (/mega|power|keno|max\s*3d|lotto|vietlott|kien thiet|xo so|ma ve|mã vé/i.test(t)) score += 0.25;
  if (typeof tesseractConf === 'number' && tesseractConf > 0) {
    score = Math.max(score, Math.min(1, tesseractConf / 100));
  }
  return Math.min(score, 1);
}

function isLikelyDateDigits(digits) {
  const s = String(digits || '');
  if (s.length === 8 && /^\d{8}$/.test(s)) {
    const d = parseInt(s.slice(0, 2), 10);
    const m = parseInt(s.slice(2, 4), 10);
    if (d >= 1 && d <= 31 && m >= 1 && m <= 12) return true;
  }
  if (s.length === 6) {
    const d = parseInt(s.slice(0, 2), 10);
    const m = parseInt(s.slice(2, 4), 10);
    if (d >= 1 && d <= 31 && m >= 1 && m <= 12) return true;
  }
  return false;
}

function vietlottMaxForProduct(product) {
  if (product === 'power') return 55;
  if (product === 'keno') return 80;
  if (product === 'lotto535') return 35;
  if (product === 'max3d') return 9;
  return 45;
}

function pickVietlottNumbers(text, product, needCount) {
  const max = vietlottMaxForProduct(product);
  const raw = text.match(/\b\d{1,2}\b/g) || [];
  const out = [];
  const seen = new Set();
  for (let i = 0; i < raw.length; i++) {
    const n = parseInt(raw[i], 10);
    if (Number.isNaN(n) || n < 1 || n > max) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    if (out.length >= needCount) break;
  }
  return out.length >= needCount ? out.slice(0, needCount) : null;
}

function detectVietlottProduct(text) {
  const lower = String(text || '').toLowerCase();
  if (/keno/i.test(lower)) return 'keno';
  if (/power|6\s*\/\s*55|655/i.test(lower)) return 'power';
  if (/max\s*3d\s*pro|max3dpro|3d\s*pro/i.test(lower)) return 'max3dpro';
  if (/max\s*3d|max3d/i.test(lower)) return 'max3d';
  if (/lotto|5\s*\/\s*35|535/i.test(lower)) return 'lotto535';
  if (/mega|6\s*\/\s*45|645/i.test(lower)) return 'mega';
  if (/vietlott/i.test(lower)) return 'mega';
  return '';
}

function extractXsktTicketNumber(text, mb) {
  const t = String(text || '');
  const lines = t.split(/\n/);
  const labeled = [];
  const plain = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const digits = line.replace(/\D/g, '');
    const label = /ma\s*ve|mã\s*vé|serial|so\s*ve|vé\s*số|ve so|ma ve/i.test(line);
    if (mb) {
      const m5 = line.match(/\b(\d{5})\b/);
      if (m5 && label) labeled.push(m5[1]);
      if (m5 && !label) plain.push(m5[1]);
    } else {
      const m6 = line.match(/\b(\d{6})\b/);
      if (m6 && !isLikelyDateDigits(m6[1])) {
        if (label) labeled.push(m6[1]);
        else plain.push(m6[1]);
      }
    }
  }

  if (labeled.length) return labeled[labeled.length - 1];

  const re = mb ? /\b(\d{5})\b/g : /\b(\d{6})\b/g;
  let m;
  const all = [];
  while ((m = re.exec(t)) !== null) {
    if (!isLikelyDateDigits(m[1])) all.push(m[1]);
  }
  if (all.length) return all[all.length - 1];
  if (plain.length) return plain[plain.length - 1];

  return '';
}

function isParseTrustworthy(parsed, text, channel) {
  if (!parsed || parsed.type === 'unknown') return false;
  if (!strictOcrParse()) return true;

  const t = String(text || '').toLowerCase();

  if (parsed.type === 'xskt') {
    const ticket = String(parsed.ticketNumber || '').replace(/\D/g, '');
    const mb = parsed.dai ? isMienBacDai(parsed.dai) : /mien\s*bac|miền\s*bắc/i.test(t);
    const needLen = mb ? 5 : 6;
    if (ticket.length !== needLen) return false;
    if (isLikelyDateDigits(ticket)) return false;

    const hasDai = !!(parsed.dai && findDaiInText(text));
    const hasLabel = /ma\s*ve|mã\s*vé|serial|so\s*ve|kien thiet|xo so/i.test(t);
    const ticketInText = new RegExp('\\b' + ticket + '\\b').test(text);
    if (channel === 'xskt' && (hasLabel || hasDai || ticketInText)) return true;
    if (channel === 'auto' && (hasLabel || (hasDai && ticketInText))) return true;
    return false;
  }

  if (parsed.type === 'vietlott') {
    const product = String(parsed.product || '').toLowerCase();
    const nums = parsed.numbers || [];
    const detected = detectVietlottProduct(text);
    if (!detected && channel !== 'vietlott') return false;
    if (detected && product && detected !== product) {
      /* allow close product family */
      if (!(detected === 'mega' && product === 'mega')) {
        /* still ok if numbers validate */
      }
    }
    if (!/keno|mega|power|max\s*3d|lotto|vietlott|655|535|645/i.test(t)) return false;

    if (product === 'keno') return nums.length >= 1 && nums.length <= 10 && nums.every((n) => n >= 1 && n <= 80);
    if (product === 'mega' || product === 'power') {
      return nums.length === 6 && nums.every((n, i, arr) => n >= 1 && n <= vietlottMaxForProduct(product));
    }
    if (product === 'lotto535') return nums.length >= 5 && nums.length <= 6;
    if (product === 'max3d') return nums.length >= 3;
    if (product === 'max3dpro') return nums.length >= 6;
    return nums.length >= 3;
  }

  return false;
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

  if (/keno/i.test(lower)) {
    const nk = pickVietlottNumbers(text, 'keno', 10);
    if (nk) return { type: 'vietlott', product: 'keno', numbers: nk };
  }
  if (/mega|6\s*\/\s*45|645/i.test(lower)) {
    const nm = pickVietlottNumbers(text, 'mega', 6);
    if (nm) return { type: 'vietlott', product: 'mega', numbers: nm };
  }
  if (/power|6\s*\/\s*55|655/i.test(lower)) {
    const np = pickVietlottNumbers(text, 'power', 6);
    if (np) return { type: 'vietlott', product: 'power', numbers: np };
  }
  if (/max\s*3d\s*pro|max3dpro|3d\s*pro/i.test(lower)) {
    const npr = pickVietlottNumbers(text, 'max3dpro', 6);
    if (npr) return { type: 'vietlott', product: 'max3dpro', numbers: npr };
  }
  if (/max\s*3d|max3d/i.test(lower)) {
    const n3 = pickVietlottNumbers(text, 'max3d', 3);
    if (n3) return { type: 'vietlott', product: 'max3d', numbers: n3 };
  }
  if (/lotto|5\s*\/\s*35|535/i.test(lower)) {
    const n535 = pickVietlottNumbers(text, 'lotto535', 6);
    if (n535) return { type: 'vietlott', product: 'lotto535', numbers: n535 };
  }

  return { type: 'unknown' };
}

function parseXsktFromText(text) {
  const foundDai = findDaiInText(text);
  const daiNorm = foundDai ? matchDai(foundDai) || foundDai : '';
  const mb = daiNorm ? isMienBacDai(daiNorm) : /mien\s*bac|miền\s*bắc/i.test(text);
  const ticket = extractXsktTicketNumber(text, mb);

  if (mb && ticket.length === 5) {
    return { type: 'xskt', ticketNumber: ticket, dai: daiNorm || 'Miền Bắc' };
  }
  if (!mb && ticket.length === 6) {
    return { type: 'xskt', ticketNumber: ticket, dai: daiNorm || undefined };
  }
  return { type: 'unknown' };
}

function parseOCRCombined(text, channel) {
  const t = String(text || '')
    .replace(/\r/g, '\n')
    .trim();
  if (!t) return { type: 'unknown' };

  let tryOrder;
  if (channel === 'vietlott') {
    tryOrder = ['vietlott', 'xskt'];
  } else if (channel === 'xskt') {
    tryOrder = ['xskt', 'vietlott'];
  } else {
    const vlHint = detectVietlottProduct(t);
    const xsHint = findDaiInText(t) || /ma\s*ve|mã\s*vé|kien thiet|xo so/i.test(t);
    if (vlHint && !xsHint) tryOrder = ['vietlott', 'xskt'];
    else if (xsHint && !vlHint) tryOrder = ['xskt', 'vietlott'];
    else tryOrder = ['xskt', 'vietlott'];
  }

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
  const text = raw.text || '';
  const parsed = parseOCRCombined(text, channel);
  if (parsed.type === 'unknown') return null;
  if (!isParseTrustworthy(parsed, text, channel)) return null;

  const drawDate = extractDrawDateFromText(text);
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
    const tessConf = typeof data.confidence === 'number' ? data.confidence : 0;
    const confidence = getConfidence(text, tessConf);
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
        error: 'OCR parse failed or not trustworthy',
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
    strictParse: strictOcrParse(),
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
