/**
 * Job đồng bộ Vietlott + XSKT vào Supabase (không chạy Express).
 * Logic scrape/parser nằm trong vietlott-scrape.js (dùng chung với server).
 *
 * draw_date lưu DB luôn dd/mm/yyyy — normalize qua normalizeDrawDateForSupabase (vietlott-scrape).
 *
 * Chạy: node sync.js  (cần file .env với SUPABASE_URL và SUPABASE_ANON_KEY hoặc SUPABASE_SERVICE_ROLE_KEY)
 */

require('dotenv').config();
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const vs = require('./vietlott-scrape');

async function main() {
  if (!process.env.SUPABASE_URL || (!process.env.SUPABASE_ANON_KEY && !process.env.SUPABASE_SERVICE_ROLE_KEY)) {
    console.error('[sync] Thiếu SUPABASE_URL hoặc một trong SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY trong .env');
    process.exit(1);
  }

  for (const product of vs.VIETLOTT_PRODUCT_IDS) {
    try {
      const data = await vs.scrapeVietlott(product, null);
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

  console.log('[sync] Hoàn tất');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
