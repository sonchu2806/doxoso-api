/**
 * Trạng thái quay — trả "Đang quay số" thay vì 500 khi đã qua giờ quay nhưng DB/scrape chưa có kết quả.
 */
const VIETNAM_TZ = 'Asia/Ho_Chi_Minh';

const DRAWING_MESSAGE = 'Đang quay số';

const DRAW_DAYS = {
  mega: [0, 3, 5],
  power: [2, 4, 6],
  max3d: [1, 3, 5],
  max3dpro: [2, 4, 6],
  lotto535: [0, 1, 2, 3, 4, 5, 6],
  keno: [0, 1, 2, 3, 4, 5, 6],
};

const XSKT_MB_DAIS = new Set(['Hà Nội', 'Hải Phòng', 'Quảng Ninh', 'Bắc Ninh', 'Nam Định', 'Thái Bình']);
const XSKT_MT_DAIS = new Set([
  'Đà Nẵng',
  'Khánh Hòa',
  'Huế',
  'Quảng Nam',
  'Bình Định',
  'Phú Yên',
  'Ninh Thuận',
  'Gia Lai',
  'Đắk Lắk',
]);

function getVietnamNowParts() {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: VIETNAM_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const pick = (t) => parts.find((p) => p.type === t)?.value || '';
  return {
    y: parseInt(pick('year'), 10),
    m: parseInt(pick('month'), 10),
    d: parseInt(pick('day'), 10),
    hour: parseInt(pick('hour'), 10),
    minute: parseInt(pick('minute'), 10),
  };
}

function parseDrawDateVi(raw) {
  const t = String(raw || '').trim();
  if (!t) return null;
  const slash = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) {
    const dt = new Date(parseInt(slash[3], 10), parseInt(slash[2], 10) - 1, parseInt(slash[1], 10));
    return Number.isNaN(dt.getTime()) ? null : dt;
  }
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const dt = new Date(parseInt(iso[1], 10), parseInt(iso[2], 10) - 1, parseInt(iso[3], 10));
    return Number.isNaN(dt.getTime()) ? null : dt;
  }
  return null;
}

function isSameVnCalendarDay(drawDateVi) {
  const vn = getVietnamNowParts();
  const d = parseDrawDateVi(drawDateVi);
  if (!d) return false;
  return d.getFullYear() === vn.y && d.getMonth() + 1 === vn.m && d.getDate() === vn.d;
}

function xsktDrawMinutes(dai) {
  if (XSKT_MB_DAIS.has(String(dai || '').trim())) return 18 * 60 + 15;
  if (XSKT_MT_DAIS.has(String(dai || '').trim())) return 17 * 60 + 15;
  return 16 * 60 + 15;
}

function vnNowMinutes() {
  const vn = getVietnamNowParts();
  return vn.hour * 60 + vn.minute;
}

/** Đã qua giờ quay XSKT trong ngày đang chọn (giờ VN). */
function isXsktPastDrawTime(dai, drawDateVi) {
  if (!isSameVnCalendarDay(drawDateVi)) return false;
  return vnNowMinutes() >= xsktDrawMinutes(dai);
}

function normVietlottKy(product, ky) {
  const n = String(ky || '').replace(/\D/g, '');
  if (!n) return '';
  return product === 'keno' ? n.padStart(7, '0') : n.padStart(5, '0');
}

/**
 * Vietlott: đang trong khung chờ công bố sau giờ quay (cùng ngày, đúng thứ quay).
 * Nếu có latestKyso thì chỉ áp dụng khi client dò đúng kỳ mới nhất.
 */
function isVietlottDrawingWindow(product, opts) {
  opts = opts || {};
  const days = DRAW_DAYS[product];
  if (!days || !days.length) return false;

  const vn = getVietnamNowParts();
  const nowMin = vnNowMinutes();
  const dow = new Date(vn.y, vn.m - 1, vn.d).getDay();
  if (!days.includes(dow)) return false;

  const kyso = opts.kyso != null ? String(opts.kyso).trim() : '';
  const latestKyso = opts.latestKyso != null ? String(opts.latestKyso).trim() : '';
  if (kyso && latestKyso && normVietlottKy(product, kyso) !== normVietlottKy(product, latestKyso)) {
    return false;
  }

  if (product === 'keno') {
    return nowMin >= 6 * 60 && nowMin < 23 * 60 + 45;
  }

  const drawHour = 18;
  const drawMin = product === 'lotto535' ? 0 : 0;
  const start = drawHour * 60 + drawMin;
  const end = 22 * 60 + 30;
  return nowMin >= start && nowMin < end;
}

function drawingResponse() {
  return { success: false, code: 'DRAWING', error: DRAWING_MESSAGE };
}

module.exports = {
  DRAWING_MESSAGE,
  drawingResponse,
  isXsktPastDrawTime,
  isVietlottDrawingWindow,
};
