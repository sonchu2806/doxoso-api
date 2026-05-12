const axios = require('axios');
const cheerio = require('cheerio');

async function run() {
  const r = await axios.get('https://vietlott.vn/vi/trung-thuong/ket-qua-trung-thuong/max-3DPro?id=00724&nocatche=1', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept-Language': 'vi-VN,vi;q=0.9' },
    timeout: 20000
  });
  const $ = cheerio.load(r.data);
  console.log('divMax3DProPlus:', $('#divMax3DProPlus').length);
  console.log('divMax3DPlus:', $('#divMax3DPlus').length);
  console.log('all div ids:', $('div[id]').map(function() { return $(this).attr('id'); }).get());
}

run().catch(console.error);