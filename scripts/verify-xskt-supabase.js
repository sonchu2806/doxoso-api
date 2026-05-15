/**
 * Kiểm tra dữ liệu xskt_results trên Supabase (số dòng, số ngày distinct).
 *   node scripts/verify-xskt-supabase.js
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.error('Thiếu SUPABASE_URL / key trong .env');
    process.exit(1);
  }
  const sb = createClient(url, key);
  const countRes = await sb.from('xskt_results').select('*', { count: 'exact', head: true });
  if (countRes.error) {
    console.error('Count error:', countRes.error.message);
    process.exit(1);
  }
  const { data, error } = await sb
    .from('xskt_results')
    .select('dai, draw_date')
    .order('draw_date', { ascending: false })
    .limit(5000);
  if (error) {
    console.error('Select error:', error.message);
    process.exit(1);
  }
  const dates = new Set();
  for (const row of data || []) {
    if (row.draw_date) dates.add(row.draw_date);
  }
  const sorted = Array.from(dates).sort();
  console.log('Tổng dòng (count):', countRes.count);
  console.log('Mẫu lấy:', (data || []).length, 'dòng');
  console.log('Số ngày distinct (trong mẫu):', dates.size);
  console.log('Ngày mới nhất:', sorted.slice(0, 5).join(', ') || '—');
  console.log('Ngày cũ nhất (trong mẫu):', sorted.slice(-5).join(', ') || '—');
  if (dates.size <= 3 && (countRes.count || 0) > 50) {
    console.log('\n⚠ Có thể backfill cũ ghi sai ngày (nhiều dòng nhưng ít ngày). Chạy lại: node sync-xskt-history.js 60');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
