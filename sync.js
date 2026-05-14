/**
 * Job đồng bộ Vietlott + XSKT vào Supabase (không chạy Express).
 * Logic scrape/parser nằm trong vietlott-scrape.js (dùng chung với server).
 *
 * draw_date lưu DB dạng yyyy-mm-dd (ISO) — normalize qua normalizeDrawDateForSupabase (vietlott-scrape).
 *
 * Chạy:
 *   node sync.js
 *     → backfill đầy đủ (cùng logic sync-history: Vietlott theo kỳ + XSKT theo ngày; env SYNC_HISTORY_*).
 *   node sync.js 30
 *     → như trên nhưng 30 ngày (tham số vị trí giống node sync-history.js 30).
 *   node sync.js --today
 *     → chỉ kỳ / trang hiện tại mỗi product + XSKT trang “hôm nay” từng miền (vài phút, không lùi lịch sử).
 *
 * Cần file .env với SUPABASE_URL và SUPABASE_ANON_KEY hoặc SUPABASE_SERVICE_ROLE_KEY
 */

require('dotenv').config();
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const vs = require('./vietlott-scrape');
const { runSyncHistory } = require('./sync-history');

function argvWithoutToday() {
  return process.argv.slice(2).filter((a) => a !== '--today');
}

async function runTodayOnly() {
  if (!process.env.SUPABASE_URL || (!process.env.SUPABASE_ANON_KEY && !process.env.SUPABASE_SERVICE_ROLE_KEY)) {
    console.error('[sync] Thiếu SUPABASE_URL hoặc một trong SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY trong .env');
    process.exit(1);
  }

  console.log('[sync] Chế độ --today: chỉ kỳ hiện tại / trang hôm nay (không backfill).');

  for (const product of vs.VIETLOTT_PRODUCT_IDS) {
    try {
      const data = await vs.scrapeVietlott(product, null, {
        forceNetwork: true,
        forwardFillFromSupabase: true,
      });
      // draw_date được ghi trong saveVietlottToSupabase (normalizeDrawDateForSupabase)
      console.log(
        '[vietlott]',
        product,
        'ok',
        JSON.stringify({
          kySo: data.kySo,
          drawDate: data.drawDate,
          numbers: data.numbers?.length,
          sets: data.sets?.length,
        })
      );
    } catch (e) {
      console.error('[vietlott]', product, 'error:', e.message);
    }
  }

  for (const region of ['mb', 'mt', 'mn']) {
    try {
      const all = await vs.scrapeAllXSKT(null, region);
      const keys = Object.keys(all);
      console.log('[xskt]', region, keys.length, 'đài');
      for (const [dai, row] of Object.entries(all)) {
        const drawDateNorm = vs.normalizeDrawDateForSupabase(row.drawDate);
        await vs.saveXSKTToSupabase(dai, drawDateNorm, row);
      }
    } catch (e) {
      console.error('[xskt]', region, e.message);
    }
  }

  console.log('[sync] Hoàn tất (--today)');
}

async function main() {
  const todayOnly = process.argv.includes('--today');
  if (todayOnly) {
    await runTodayOnly();
    return;
  }

  console.log('[sync] Chế độ đầy đủ: backfill Vietlott + XSKT (giống sync-history.js).');
  await runSyncHistory(argvWithoutToday());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

