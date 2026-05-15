/**
 * Backfill kết quả XSKT (3 miền) lên Supabase — không chạy Vietlott.
 *
 * Chạy:
 *   node sync-xskt-history.js        → 60 ngày (mặc định)
 *   node sync-xskt-history.js 45     → 45 ngày
 *
 * Env:
 *   SYNC_XSKT_HISTORY_DAYS — mặc định 60 (tối đa 120)
 *   XSKT_BACKFILL_DELAY_MS — delay giữa mỗi lần scrape (mặc định 400)
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (khuyến nghị)
 */

require('dotenv').config();
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const vs = require('./vietlott-scrape');

async function runSyncXsktHistory(argvSlice) {
  const slice = Array.isArray(argvSlice) ? argvSlice : process.argv.slice(2);
  const DAYS = Math.max(
    1,
    Math.min(120, parseInt(slice[0] || process.env.SYNC_XSKT_HISTORY_DAYS || '60', 10))
  );

  if (
    !process.env.SUPABASE_URL ||
    (!process.env.SUPABASE_ANON_KEY && !process.env.SUPABASE_SERVICE_ROLE_KEY)
  ) {
    console.error(
      '[sync-xskt] Thiếu SUPABASE_URL hoặc SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY trong .env'
    );
    process.exit(1);
  }

  const end = new Date();
  end.setHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setDate(start.getDate() - DAYS);

  console.log(
    '[sync-xskt] Backfill XSKT only —',
    DAYS,
    'ngày |',
    vs.formatMinhNgocDaySlug(start),
    '→',
    vs.formatMinhNgocDaySlug(end),
    '| 3 miền (mb, mt, mn)'
  );

  const stats = await vs.backfillXSKTDateRangeToSupabase(start, end);
  console.log('[sync-xskt] Hoàn tất:', JSON.stringify(stats, null, 2));
  return stats;
}

module.exports = { runSyncXsktHistory };

if (require.main === module) {
  runSyncXsktHistory(process.argv.slice(2)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
