/**
 * Đồng bộ Vietlott + XSKT lên Supabase.
 * - Vietlott: mega/power/max3d/max3dpro/lotto535 theo **SYNC_HISTORY_DAYS** (mặc định 15 ngày);
 *   **Keno** chỉ lùi **SYNC_HISTORY_KENO_DAYS** (mặc định 5 ngày).
 * - XSKT: mỗi ngày trong khoảng **SYNC_HISTORY_DAYS** × 3 miền.
 *
 * Chạy:
 *   node sync-history.js
 *   node sync-history.js 30   → 30 ngày (Vietlott không-Keno + XSKT; Keno vẫn dùng env keno days)
 *
 * `runSyncHistory` được export cho sync.js (mặc định `node sync.js` = backfill giống file này).
 *
 * Biến môi trường:
 *   SYNC_HISTORY_DAYS — ngày cho sản phẩm không phải Keno + XSKT (mặc định 15)
 *   SYNC_HISTORY_KENO_DAYS — ngày chỉ cho Keno (mặc định 5)
 *   SYNC_HISTORY_SKIP_KENO=1 — bỏ hẳn Keno
 *   SUPABASE_SERVICE_ROLE_KEY — khuyến nghị
 */

require('dotenv').config();
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const vs = require('./vietlott-scrape');

const KENO_DAYS = Math.max(
  1,
  Math.min(120, parseInt(process.env.SYNC_HISTORY_KENO_DAYS || '5', 10))
);
const SKIP_KENO = process.env.SYNC_HISTORY_SKIP_KENO === '1';

/**
 * @param {string[]} [argvSlice] — giống process.argv.slice(2) (vd. ['30'] cho 30 ngày). Mặc định slice từ process.argv.
 */
async function runSyncHistory(argvSlice) {
  const slice = Array.isArray(argvSlice) ? argvSlice : process.argv.slice(2);
  const DAYS = Math.max(
    1,
    Math.min(120, parseInt(slice[0] || process.env.SYNC_HISTORY_DAYS || '15', 10))
  );

  if (
    !process.env.SUPABASE_URL ||
    (!process.env.SUPABASE_ANON_KEY && !process.env.SUPABASE_SERVICE_ROLE_KEY)
  ) {
    console.error(
      '[sync-history] Thiếu SUPABASE_URL hoặc một trong SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY trong .env'
    );
    process.exit(1);
  }

  console.log(
    '[sync-history] Vietlott (không Keno):',
    DAYS,
    'ngày | Keno:',
    SKIP_KENO ? 'bỏ qua' : KENO_DAYS + ' ngày | XSKT: ' + DAYS + ' ngày'
  );

  const products = SKIP_KENO
    ? vs.VIETLOTT_PRODUCT_IDS.filter((p) => p !== 'keno')
    : vs.VIETLOTT_PRODUCT_IDS;

  console.log('[sync-history] (1/2) Vietlott — backfill theo kỳ');
  const vlStats = await vs.backfillVietlottMonthsToSupabase(2, {
    products,
    days: DAYS,
    kenoDays: SKIP_KENO ? undefined : KENO_DAYS,
  });
  console.log('[sync-history] Vietlott:', vlStats);

  const end = new Date();
  end.setHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setDate(start.getDate() - DAYS);

  console.log(
    '[sync-history] (2/2) XSKT —',
    vs.formatMinhNgocDaySlug(start),
    '→',
    vs.formatMinhNgocDaySlug(end)
  );
  const xsktStats = await vs.backfillXSKTDateRangeToSupabase(start, end);
  console.log('[sync-history] XSKT:', xsktStats);

  console.log('[sync-history] Hoàn tất');
}

module.exports = { runSyncHistory };

if (require.main === module) {
  runSyncHistory(process.argv.slice(2)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
