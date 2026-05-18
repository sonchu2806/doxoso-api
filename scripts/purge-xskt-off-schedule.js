/**
 * Xóa dòng xskt_results ghi nhầm đài không quay đúng thứ (VD TP.HCM từ block 11/5).
 *   node scripts/purge-xskt-off-schedule.js
 *   node scripts/purge-xskt-off-schedule.js 2026-05-01 2026-05-31
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const vs = require('../vietlott-scrape');

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.error('Thiếu SUPABASE_URL / key');
    process.exit(1);
  }
  const sb = createClient(url, key);
  const end = new Date();
  end.setHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setDate(start.getDate() - 90);
  const argStart = process.argv[2];
  const argEnd = process.argv[3];
  if (argStart) start.setTime(new Date(argStart).getTime());
  if (argEnd) end.setTime(new Date(argEnd).getTime());

  const { data, error } = await sb
    .from('xskt_results')
    .select('dai, draw_date')
    .gte('draw_date', vs.normalizeDrawDateForSupabase(start))
    .lte('draw_date', vs.normalizeDrawDateForSupabase(end));
  if (error) {
    console.error(error.message);
    process.exit(1);
  }

  let removed = 0;
  for (const row of data || []) {
    const vi = row.draw_date;
    const region = vs.detectRegionByDai(row.dai);
    if (vs.xsktDaiScheduledOnDrawDate(region, row.dai, vi)) continue;
    const { error: delErr } = await sb
      .from('xskt_results')
      .delete()
      .eq('dai', row.dai)
      .eq('draw_date', row.draw_date);
    if (delErr) {
      console.warn('delete failed', row.dai, row.draw_date, delErr.message);
      continue;
    }
    removed++;
    console.log('removed', row.dai, row.draw_date, vi);
  }
  console.log('Done. Removed', removed, 'of', (data || []).length, 'rows in range');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
