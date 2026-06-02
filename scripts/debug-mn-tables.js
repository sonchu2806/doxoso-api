/**
 * Debug Minh Ngọc bkq tables on a day page.
 *   node scripts/debug-mn-tables.js 15-05-2026
 */
require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const vs = require('../vietlott-scrape');

const slug = process.argv[2] || '16-05-2026';
const url = 'https://www.minhngoc.net.vn/ket-qua-xo-so/mien-nam/' + slug + '.html';

async function main() {
  const { data: html } = await axios.get(url, {
    timeout: 30000,
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  const $ = cheerio.load(html);
  const m = slug.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  const wantedIso = vs.normalizeDrawDateForSupabase(m[1] + '/' + m[2] + '/' + m[3]);
  console.log('URL', url, '| wantedIso', wantedIso);

  $('table[class*="bkq"]').each((i, tableEl) => {
    const $table = $(tableEl);
    const ngayHref = $table.find('td.ngay a').first().attr('href') || '';
    const ngayText = ($table.find('td.ngay').first().text() || '').trim();
    const tinhs = $table
      .find('td.tinh')
      .map((_, el) => ($(el).text() || '').trim().split('\n')[0])
      .get()
      .filter(Boolean);
    const db = ($table.find('td.giaidb').first().text() || '').replace(/\D/g, '').slice(0, 6);
    const prevNgay = $table.prevAll('td.ngay, tr:has(td.ngay)').first().find('td.ngay a').attr('href');
    console.log(
      'table',
      i,
      '| ngay in table:',
      ngayText.slice(0, 14) || '(empty)',
      ngayHref.slice(-25),
      '| tinh:',
      tinhs.join(' · '),
      '| đb:',
      db
    );
  });

  const all = await vs.scrapeAllXSKT(slug, 'mn');
  const key = vs.findXsktDaiKeyInResults(all, 'TP. HCM');
  console.log('parsed TP.HCM drawDate:', key && all[key].drawDate, 'đb:', key && all[key].specialPrize);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
