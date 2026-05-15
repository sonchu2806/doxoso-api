'use strict';

const axios = require('axios');

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

/** In-memory quota + logs (không cần migration Supabase để chạy). */
const mem = {
  dayKey: '',
  totalToday: 0,
  byIp: {},
  logs: [],
};

const MAX_LOGS = 400;

function dayKeyUtcPlus7() {
  const now = Date.now() + 7 * 3600 * 1000;
  const d = new Date(now);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}

function resetDayIfNeeded() {
  const k = dayKeyUtcPlus7();
  if (mem.dayKey !== k) {
    mem.dayKey = k;
    mem.totalToday = 0;
    mem.byIp = {};
  }
}

function envInt(name, fallback) {
  const n = parseInt(process.env[name] || String(fallback), 10);
  return Number.isFinite(n) ? n : fallback;
}

function getConfig() {
  return {
    enabled: process.env.SCAN_VISION_ENABLED === '1' || process.env.SCAN_VISION_ENABLED === 'true',
    apiKey: String(process.env.ANTHROPIC_API_KEY || '').trim(),
    model: String(process.env.SCAN_VISION_MODEL || 'claude-sonnet-4-20250514').trim(),
    maxPerDay: envInt('SCAN_VISION_MAX_PER_DAY', 200),
    maxPerIpPerDay: envInt('SCAN_VISION_MAX_PER_IP_PER_DAY', 20),
    maxImageBytes: envInt('SCAN_VISION_MAX_IMAGE_BYTES', 1500000),
    maxTokens: envInt('SCAN_VISION_MAX_OUTPUT_TOKENS', 512),
  };
}

function normDai(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\./g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchDai(raw) {
  const t = normDai(raw);
  if (!t) return '';
  if (t.includes('mien bac') || t === 'mb') return 'Miền Bắc';
  for (const d of DAI_LIST) {
    const nd = normDai(d);
    if (t.includes(nd) || nd.includes(t)) {
      if (d === 'TP.HCM') return 'TP. Hồ Chí Minh';
      if (d === 'Huế') return 'Thừa Thiên Huế';
      return d;
    }
  }
  return String(raw || '').trim();
}

function normalizeDrawDateVi(s) {
  if (!s) return '';
  const t = String(s).trim();
  let m = t.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (m) {
    return (
      String(parseInt(m[1], 10)).padStart(2, '0') +
      '/' +
      String(parseInt(m[2], 10)).padStart(2, '0') +
      '/' +
      m[3]
    );
  }
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[3] + '/' + m[2] + '/' + m[1];
  return t;
}

function isMienBacDai(dai) {
  const n = normDai(dai);
  if (n.includes('mien bac')) return true;
  return MB_DAI.some((d) => normDai(d) === n);
}

function extractJsonObject(text) {
  const t = String(text || '').trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch (_e) {
      /* continue */
    }
  }
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch (_e) {
      return null;
    }
  }
  return null;
}

function postProcessParsed(obj, channel) {
  const type = String(obj.type || channel || 'xskt').toLowerCase();
  if (type === 'vietlott' || type === 'vl') {
    const product = String(obj.product || 'mega')
      .toLowerCase()
      .replace(/\s+/g, '');
    const nums = Array.isArray(obj.numbers)
      ? obj.numbers.map((n) => parseInt(String(n).replace(/\D/g, ''), 10)).filter((n) => !Number.isNaN(n) && n >= 0)
      : [];
    return {
      type: 'vietlott',
      product: product || 'mega',
      numbers: nums,
      dai: null,
      drawDate: normalizeDrawDateVi(obj.drawDate),
      ticketNumber: '',
    };
  }

  const dai = matchDai(obj.dai || obj.station || '');
  const drawDate = normalizeDrawDateVi(obj.drawDate || obj.date || '');
  let ticketNumber = String(obj.ticketNumber || obj.ticket || obj.maVe || '').replace(/\D/g, '');
  const mb = isMienBacDai(dai);
  if (mb && ticketNumber.length > 5) {
    const m5 = ticketNumber.match(/(\d{5})/);
    if (m5) ticketNumber = m5[1];
  } else if (!mb) {
    const all = String(obj.ticketNumber || obj.ticket || '').replace(/\D/g, '');
    const matches = all.match(/\d{6}/g);
    if (matches && matches.length) {
      ticketNumber = matches[matches.length - 1];
    } else if (ticketNumber.length > 6) {
      ticketNumber = ticketNumber.slice(-6);
    }
  }
  if (ticketNumber.length < (mb ? 5 : 6)) {
    return { type: 'unknown', error: 'Không đủ số vé sau khi chuẩn hóa' };
  }

  return {
    type: 'xskt',
    dai: dai || undefined,
    drawDate,
    ticketNumber: ticketNumber.slice(0, mb ? 5 : 6),
    product: null,
    numbers: [],
  };
}

function buildPrompt(channel) {
  const daiHint = DAI_LIST.slice(0, 20).join(', ') + ', …';
  if (channel === 'vietlott') {
    return (
      'Bạn đọc ảnh vé số Vietlott (Mega, Power, Keno, Max3D, Lotto). ' +
      'Trả DUY NHẤT một JSON hợp lệ, không markdown, không giải thích:\n' +
      '{"type":"vietlott","product":"mega|power|keno|max3d|max3dpro|lotto535","numbers":[...],"drawDate":"dd/mm/yyyy hoặc rỗng"}\n' +
      'numbers là các số trúng trên vé (số nguyên).'
    );
  }
  return (
    'Bạn đọc ảnh vé xổ số kiến thiết Việt Nam (XSKT). ' +
    'Trả DUY NHẤT một JSON hợp lệ, không markdown, không giải thích:\n' +
    '{"type":"xskt","dai":"tên đài","drawDate":"dd/mm/yyyy","ticketNumber":"6 chữ số vé (miền Bắc 5 số)"}\n' +
    'dai là một trong: ' +
    daiHint +
    '. ticketNumber là dãy số lớn in trên vé (6 số), không lấy ngày làm mã vé.'
  );
}

function detectMediaType(buf) {
  if (!buf || buf.length < 4) return 'image/jpeg';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif';
  if (buf[0] === 0x52 && buf[1] === 0x49) return 'image/webp';
  return 'image/jpeg';
}

function estimateUsd(promptTokens, completionTokens) {
  const inPrice = parseFloat(process.env.SCAN_VISION_USD_PER_1M_INPUT || '3');
  const outPrice = parseFloat(process.env.SCAN_VISION_USD_PER_1M_OUTPUT || '15');
  return (promptTokens / 1e6) * inPrice + (completionTokens / 1e6) * outPrice;
}

function pushLog(entry) {
  mem.logs.unshift(entry);
  if (mem.logs.length > MAX_LOGS) mem.logs.length = MAX_LOGS;
}

function checkQuota(clientIp) {
  resetDayIfNeeded();
  const cfg = getConfig();
  if (!cfg.enabled) {
    return { ok: false, status: 503, error: 'Scan vision đang tắt (SCAN_VISION_ENABLED).' };
  }
  if (!cfg.apiKey) {
    return { ok: false, status: 503, error: 'Chưa cấu hình ANTHROPIC_API_KEY trên server.' };
  }
  if (mem.totalToday >= cfg.maxPerDay) {
    return {
      ok: false,
      status: 429,
      error: 'Đã hết lượt scan vision hôm nay (toàn hệ thống).',
    };
  }
  const ip = String(clientIp || 'unknown').slice(0, 64);
  const ipCount = mem.byIp[ip] || 0;
  if (ipCount >= cfg.maxPerIpPerDay) {
    return {
      ok: false,
      status: 429,
      error: 'Đã hết lượt scan vision hôm nay cho thiết bị/IP này.',
    };
  }
  return { ok: true, cfg, ip };
}

function recordQuota(ip) {
  resetDayIfNeeded();
  mem.totalToday += 1;
  mem.byIp[ip] = (mem.byIp[ip] || 0) + 1;
}

async function callAnthropicVision(imageBase64, mediaType, channel) {
  const cfg = getConfig();
  const res = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: cfg.model,
      max_tokens: cfg.maxTokens,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: imageBase64,
              },
            },
            {
              type: 'text',
              text: buildPrompt(channel),
            },
          ],
        },
      ],
    },
    {
      headers: {
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      timeout: 90000,
    }
  );

  const usage = res.data && res.data.usage ? res.data.usage : {};
  const promptTokens = usage.input_tokens || 0;
  const completionTokens = usage.output_tokens || 0;
  let text = '';
  const content = res.data && res.data.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && block.type === 'text' && block.text) text += block.text;
    }
  }
  return {
    text,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estimatedUsd: estimateUsd(promptTokens, completionTokens),
  };
}

/**
 * @param {Buffer} imageBuffer
 * @param {string} channel - xskt | vietlott
 * @param {{ clientIp?: string, userAgent?: string }} meta
 */
async function scanTicketFromImage(imageBuffer, channel, meta) {
  meta = meta || {};
  const ch = channel === 'vietlott' ? 'vietlott' : 'xskt';
  const quota = checkQuota(meta.clientIp);
  if (!quota.ok) {
    return { success: false, status: quota.status, error: quota.error };
  }

  const cfg = quota.cfg;
  if (!imageBuffer || !imageBuffer.length) {
    return { success: false, status: 400, error: 'Thiếu file ảnh.' };
  }
  if (imageBuffer.length > cfg.maxImageBytes) {
    return {
      success: false,
      status: 400,
      error: 'Ảnh quá lớn (tối đa ' + Math.round(cfg.maxImageBytes / 1024) + ' KB).',
    };
  }

  const mediaType = detectMediaType(imageBuffer);
  const imageBase64 = imageBuffer.toString('base64');
  const started = Date.now();

  try {
    const api = await callAnthropicVision(imageBase64, mediaType, ch);
    const rawObj = extractJsonObject(api.text);
    if (!rawObj) {
      recordQuota(quota.ip);
      pushLog({
        at: new Date().toISOString(),
        ip: quota.ip,
        channel: ch,
        success: false,
        model: cfg.model,
        promptTokens: api.promptTokens,
        completionTokens: api.completionTokens,
        totalTokens: api.totalTokens,
        estimatedUsd: api.estimatedUsd,
        ms: Date.now() - started,
        error: 'Không parse được JSON từ Claude',
      });
      return {
        success: false,
        status: 422,
        error: 'Không đọc được vé từ ảnh. Thử chụp rõ hơn hoặc nhập tay.',
        rawText: api.text.slice(0, 500),
      };
    }

    const parsed = postProcessParsed(rawObj, ch);
    if (parsed.type === 'unknown') {
      recordQuota(quota.ip);
      pushLog({
        at: new Date().toISOString(),
        ip: quota.ip,
        channel: ch,
        success: false,
        model: cfg.model,
        promptTokens: api.promptTokens,
        completionTokens: api.completionTokens,
        totalTokens: api.totalTokens,
        estimatedUsd: api.estimatedUsd,
        ms: Date.now() - started,
        error: parsed.error || 'unknown',
      });
      return {
        success: false,
        status: 422,
        error: parsed.error || 'Không nhận diện được vé.',
      };
    }

    recordQuota(quota.ip);
    pushLog({
      at: new Date().toISOString(),
      ip: quota.ip,
      channel: ch,
      success: true,
      model: cfg.model,
      promptTokens: api.promptTokens,
      completionTokens: api.completionTokens,
      totalTokens: api.totalTokens,
      estimatedUsd: api.estimatedUsd,
      ms: Date.now() - started,
      result: parsed,
    });

    return {
      success: true,
      source: 'claude-vision',
      usage: {
        promptTokens: api.promptTokens,
        completionTokens: api.completionTokens,
        totalTokens: api.totalTokens,
        estimatedUsd: api.estimatedUsd,
      },
      data: parsed,
    };
  } catch (e) {
    const msg =
      (e.response && e.response.data && e.response.data.error && e.response.data.error.message) ||
      e.message ||
      'Lỗi gọi Claude API';
    pushLog({
      at: new Date().toISOString(),
      ip: quota.ip,
      channel: ch,
      success: false,
      model: cfg.model,
      ms: Date.now() - started,
      error: msg,
    });
    const status = e.response && e.response.status === 401 ? 503 : e.response && e.response.status ? e.response.status : 500;
    return { success: false, status, error: msg };
  }
}

function getUsageStats() {
  resetDayIfNeeded();
  const cfg = getConfig();
  const todayLogs = mem.logs.filter((l) => l.at && l.at.slice(0, 10) === mem.dayKey);
  const tokensToday = todayLogs.reduce((s, l) => s + (l.totalTokens || 0), 0);
  const usdToday = todayLogs.reduce((s, l) => s + (l.estimatedUsd || 0), 0);
  const okToday = todayLogs.filter((l) => l.success).length;

  return {
    dayKey: mem.dayKey,
    config: {
      enabled: cfg.enabled,
      model: cfg.model,
      maxPerDay: cfg.maxPerDay,
      maxPerIpPerDay: cfg.maxPerIpPerDay,
      maxImageBytes: cfg.maxImageBytes,
      hasApiKey: !!cfg.apiKey,
    },
    today: {
      calls: mem.totalToday,
      remaining: Math.max(0, cfg.maxPerDay - mem.totalToday),
      successCount: okToday,
      totalTokens: tokensToday,
      estimatedUsd: Math.round(usdToday * 10000) / 10000,
    },
    recentLogs: mem.logs.slice(0, 25),
  };
}

module.exports = {
  getConfig,
  checkQuota,
  scanTicketFromImage,
  getUsageStats,
  matchDai,
  normalizeDrawDateVi,
};
