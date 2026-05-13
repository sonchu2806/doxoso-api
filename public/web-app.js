'use strict';

(function () {
  function forEachNode(nodes, fn) {
    for (var i = 0; i < nodes.length; i++) fn(nodes[i]);
  }

  function findClickTarget(fromEl, stopEl) {
    var el = fromEl;
    while (el && el !== stopEl) {
      if (el.nodeType === 1) {
        if (el.id === 'btn-check') return el;
        if (el.getAttribute('data-product')) return el;
        if (el.getAttribute('data-kenotab')) return el;
        if (el.getAttribute('data-ktext')) return el;
        if (el.getAttribute('data-pick')) return el;
        if (el.getAttribute('data-spec')) return el;
        if (el.getAttribute('data-xregion')) return el;
        if (el.getAttribute('data-xdai')) return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  function apiBase() {
    var q = new URLSearchParams(location.search).get('api');
    if (q) return q.replace(/\/$/, '');
    if (location.protocol === 'http:' || location.protocol === 'https:') return location.origin;
    return 'https://web-production-d8605.up.railway.app';
  }
  var API_BASE = apiBase();

  var KEY = 'doxoso_saved_tickets';

  /** Logo PNG trong /public/assets (copy từ doxoso-mini) */
  var MOMO_CONSENT_HTML =
    '<p class="momo-consent">Bằng việc ấn Dò kết quả bạn đồng ý cho phép MoMo lưu lại thông tin vé, MoMo cam kết chỉ sử dụng để tra cứu kết quả</p>';

  var LOGO_SRC = {
    keno: '/assets/vietlott-logos/keno.png',
    mega: '/assets/vietlott-logos/mega645.png',
    power: '/assets/vietlott-logos/power655.png',
    max3d: '/assets/vietlott-logos/max3d.png',
    max3dpro: '/assets/vietlott-logos/max3dpro.png',
    lotto535: '/assets/vietlott-logos/lotto535.png',
  };

  var BANNERS = {
    mega: { t: 'Mega 6/45', n: 'Chọn 6 số từ 01-45. Quay thưởng T4, T6, CN.', tag: 'T4 · T6 · CN', bg: '#F3F1FF', b: '#DCCFFF', tg: '#E7E2FF', tc: '#6C58F7' },
    power: { t: 'Power 6/55', n: 'Chọn 6 số từ 01-55. Có Jackpot 1 và Jackpot 2.', tag: 'T3 · T5 · T7', bg: '#EDF6FF', b: '#CFE3FF', tg: '#DBECFF', tc: '#2E7FD6' },
    keno: { t: 'Keno', n: 'Chọn tối đa 10 số từ 01-80. Quay liên tục nhiều kỳ/ngày.', tag: 'Mỗi ~8 phút', bg: '#FFF5EC', b: '#F7D9BB', tg: '#FFE7CE', tc: '#D5862E' },
    max3d: { t: 'Max 3D', n: 'Nhập bộ 3 chữ số. Quay T2, T4, T6.', tag: 'T2 · T4 · T6', bg: '#ECFBF4', b: '#C8F1DF', tg: '#DDF9EC', tc: '#24A972' },
    max3dpro: { t: 'Max 3D Pro', n: 'Nhập 2 bộ số A/B để tăng cơ hội trúng.', tag: 'T2 · T4 · T6', bg: '#EAFBF3', b: '#C5EDD9', tg: '#DCF7EA', tc: '#1D9A67' },
    lotto535: { t: 'Lotto 5/35', n: 'Chọn 5 số từ 01-35. Quay thưởng mỗi ngày.', tag: 'Hàng ngày · 18:00', bg: '#FFF8EA', b: '#F0E3C2', tg: '#FDEAB8', tc: '#D49B00' },
  };

  var XSKT_SCHEDULE = {
    mb: { 1: ['Hà Nội'], 2: ['Quảng Ninh'], 3: ['Bắc Ninh'], 4: ['Hà Nội'], 5: ['Hải Phòng'], 6: ['Nam Định'], 0: ['Thái Bình'] },
    mn: {
      1: ['TP. Hồ Chí Minh', 'Đồng Tháp', 'Cà Mau'],
      2: ['Bến Tre', 'Vũng Tàu', 'Bạc Liêu'],
      3: ['Đồng Nai', 'Cần Thơ', 'Sóc Trăng'],
      4: ['Tây Ninh', 'An Giang', 'Bình Thuận'],
      5: ['Vĩnh Long', 'Bình Dương', 'Trà Vinh'],
      6: ['TP. Hồ Chí Minh', 'Long An', 'Bình Phước', 'Hậu Giang'],
      0: ['Tiền Giang', 'Kiên Giang', 'Đà Lạt'],
    },
    mt: {
      1: ['Thừa Thiên Huế', 'Phú Yên'],
      2: ['Đắk Lắk', 'Quảng Nam'],
      3: ['Đà Nẵng', 'Khánh Hòa'],
      4: ['Bình Định', 'Quảng Trị', 'Quảng Bình'],
      5: ['Gia Lai', 'Ninh Thuận'],
      6: ['Đà Nẵng', 'Quảng Ngãi', 'Đắk Nông'],
      0: ['Kon Tum', 'Khánh Hòa', 'Thừa Thiên Huế'],
    },
  };

  var state = {
    channel: 'vietlott',
    tab: 'do',
    product: 'keno',
    kenoTab: 'so',
    kenoText: null,
    picker: [],
    lottoSpec: [],
    slots: ['', '', ''],
    pro: [
      ['', '', ''],
      ['', '', ''],
    ],
    ky: '',
    kyList: [],
    xsktTicket: '',
    xsktDai: 'TP. Hồ Chí Minh',
    xsktDate: new Date().toLocaleDateString('vi-VN'),
    xsktRegion: 'mn',
    loading: false,
    apiResult: null,
    checkResult: null,
  };

  function toast(msg) {
    var el = document.getElementById('toast');
    el.textContent = msg;
    el.style.display = 'block';
    clearTimeout(toast._t);
    toast._t = setTimeout(function () {
      el.style.display = 'none';
    }, 3200);
  }

  function fetchJSON(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('Server lỗi: ' + r.status);
      return r.json();
    });
  }

  function fetchVietlott(product, kyso) {
    var u =
      kyso && String(kyso).trim()
        ? API_BASE + '/vietlott/' + product + '?kyso=' + encodeURIComponent(String(kyso).trim())
        : API_BASE + '/vietlott/' + product;
    return fetchJSON(u).then(function (j) {
      if (!j.success) throw new Error(j.error || 'Lỗi');
      return j.data;
    });
  }

  function fetchXskt(dai, dateVi) {
    var norm = dateVi ? dateVi.replace(/\//g, '-') : '';
    var u =
      norm
        ? API_BASE + '/xskt?dai=' + encodeURIComponent(dai) + '&date=' + encodeURIComponent(norm)
        : API_BASE + '/xskt?dai=' + encodeURIComponent(dai);
    return fetchJSON(u).then(function (j) {
      if (!j.success) throw new Error(j.error || 'Lỗi');
      return j.data;
    });
  }

  function checkVietlottTicket(myNumbers, result, product) {
    var mainNumbers = product === 'lotto535' ? myNumbers.slice(0, 5) : myNumbers.slice();
    var matched = mainNumbers.filter(function (n) {
      return ((result && result.numbers) || []).indexOf(n) !== -1;
    });
    var hasPower = result && result.powerNumber !== undefined && myNumbers.indexOf(result.powerNumber) !== -1;
    var prize = '';
    if (product === 'mega') {
      if (matched.length === 6) prize = 'Jackpot';
      else if (matched.length === 5) prize = 'Giải nhất';
      else if (matched.length === 4) prize = 'Giải nhì';
      else if (matched.length === 3) prize = 'Giải ba';
    } else if (product === 'power') {
      if (matched.length === 6 && hasPower) prize = 'Jackpot 1';
      else if (matched.length === 6) prize = 'Jackpot 2';
      else if (matched.length === 5 && hasPower) prize = 'Giải nhất';
      else if (matched.length === 5) prize = 'Giải nhì';
      else if (matched.length === 4) prize = 'Giải ba';
      else if (matched.length === 3) prize = 'Giải tư';
    } else if (product === 'lotto535') {
      if (matched.length === 5 && hasPower) prize = 'Jackpot';
      else if (matched.length === 5) prize = 'Giải nhất';
      else if (matched.length === 4) prize = 'Giải nhì';
      else if (matched.length === 3) prize = 'Giải ba';
    } else if (product === 'keno') {
      var n = mainNumbers.length;
      if (n === 10) {
        var pm = { 10: 'Keno 10/10', 9: 'Keno 9/10', 8: 'Keno 8/10', 7: 'Keno 7/10', 6: 'Keno 6/10', 5: 'Keno 5/10', 0: 'Keno 0/10' };
        if (pm[matched.length]) prize = pm[matched.length];
      } else if (n >= 1 && n <= 10) {
        var k = matched.length;
        if (k === n) prize = 'Keno trúng ' + k + '/' + n + ' số (trùng hết)';
        else if (k >= 5) prize = 'Keno trúng ' + k + '/' + n + ' số';
        else if (k >= 3) prize = 'Keno trúng ' + k + '/' + n + ' số (xem bảng giải theo số cược)';
      }
    }
    return { matched: matched, prize: prize, amount: 0 };
  }

  function stripViAccents(s) {
    var t = String(s || '').toLowerCase();
    try {
      if (typeof t.normalize === 'function') {
        t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      }
    } catch (e) {}
    return t;
  }

  function checkXSKTTicket(ticketNumber, result) {
    var ticket = String(ticketNumber || '').replace(/\D/g, '');
    if (!ticket) return { matched: false, prize: '', amount: 0 };

    function getPrizeMeta(label) {
      var l = stripViAccents(label);
      if (l.indexOf('dac biet') !== -1) return { digits: 6, rank: 0 };
      if (l.indexOf('nhat') !== -1 || l.indexOf('giai 1') !== -1) return { digits: 5, rank: 1 };
      if (l.indexOf('nhi') !== -1 || l.indexOf('giai 2') !== -1) return { digits: 5, rank: 2 };
      if (l.indexOf('ba') !== -1 || l.indexOf('giai 3') !== -1) return { digits: 5, rank: 3 };
      if (l.indexOf('tu') !== -1 || l.indexOf('giai 4') !== -1) return { digits: 5, rank: 4 };
      if (l.indexOf('nam') !== -1 || l.indexOf('giai 5') !== -1) return { digits: 4, rank: 5 };
      if (l.indexOf('sau') !== -1 || l.indexOf('giai 6') !== -1) return { digits: 4, rank: 6 };
      if (l.indexOf('bay') !== -1 || l.indexOf('giai 7') !== -1) return { digits: 3, rank: 7 };
      if (l.indexOf('tam') !== -1 || l.indexOf('giai 8') !== -1) return { digits: 2, rank: 8 };
      return { digits: 6, rank: 99 };
    }

    var best = null;
    ((result && result.prizes) || []).forEach(function (p) {
      var meta = getPrizeMeta(p.label || '');
      var digits = meta.digits;
      var rank = meta.rank;
      (p.numbers || []).forEach(function (num) {
        var win = String(num || '').replace(/\D/g, '');
        if (!win) return;
        var tailLen = Math.min(digits, ticket.length, win.length);
        if (tailLen <= 0) return;
        if (ticket.slice(-tailLen) === win.slice(-tailLen)) {
          if (!best || rank < best.rank) best = { prize: p.label, rank: rank };
        }
      });
    });
    if (best) return { matched: true, prize: best.prize, amount: 0 };
    return { matched: false, prize: '', amount: 0 };
  }

  function evaluateKenoText(choice, numbers) {
    var evenCount = numbers.filter(function (n) {
      return n % 2 === 0;
    }).length;
    var oddCount = numbers.length - evenCount;
    var highCount = numbers.filter(function (n) {
      return n > 40;
    }).length;
    var lowCount = numbers.length - highCount;
    var map = {
      chan: { isWin: evenCount >= 13, title: 'Chẵn', summary: 'Chẵn ' + evenCount + ' / Lẻ ' + oddCount },
      chan1112: { isWin: evenCount === 11 || evenCount === 12, title: 'Chẵn 11-12', summary: 'Chẵn ' + evenCount + ' / Lẻ ' + oddCount },
      hoachanle: { isWin: evenCount === 10 && oddCount === 10, title: 'Hòa Chẵn/Lẻ', summary: 'Chẵn ' + evenCount + ' / Lẻ ' + oddCount },
      le1112: { isWin: oddCount === 11 || oddCount === 12, title: 'Lẻ 11-12', summary: 'Lẻ ' + oddCount + ' / Chẵn ' + evenCount },
      le: { isWin: oddCount >= 13, title: 'Lẻ', summary: 'Lẻ ' + oddCount + ' / Chẵn ' + evenCount },
      lon: { isWin: highCount >= 11, title: 'Lớn', summary: 'Lớn ' + highCount + ' (41-80) / Nhỏ ' + lowCount + ' (01-40)' },
      hoalonnho: { isWin: highCount === 10 && lowCount === 10, title: 'Hòa Lớn/Nhỏ', summary: 'Lớn ' + highCount + ' (41-80) / Nhỏ ' + lowCount + ' (01-40)' },
      nho: { isWin: lowCount >= 11, title: 'Nhỏ', summary: 'Nhỏ ' + lowCount + ' (01-40) / Lớn ' + highCount + ' (41-80)' },
    };
    var sel = map[choice];
    if (!sel) return { isWin: false, prize: '', amount: 0, summary: '' };
    return {
      isWin: sel.isWin,
      prize: sel.isWin ? 'Keno ' + sel.title : '',
      amount: sel.isWin ? 20000 : 0,
      summary: sel.summary,
    };
  }

  function max3dCheck(product, result, slots, pro) {
    var userTickets =
      product === 'max3d'
        ? [slots.filter(function (v) {
            return v !== '';
          }).join('')]
        : pro.map(function (arr) {
            return arr.filter(function (v) {
              return v !== '';
            }).join('');
          });
    var validTickets = userTickets.filter(function (t) {
      return t.length === 3;
    });
    var sets = Array.isArray(result.sets) ? result.sets : [];
    var byPrize = { db: [], n1: [], n2: [], n3: [] };
    sets.forEach(function (s) {
      var label = String((s && s.label) || '').toLowerCase();
      var num = String(((s && s.numbers) || []).join('') || '');
      if (!num) return;
      if (label.indexOf('đặc biệt') !== -1 || label.indexOf('dac biet') !== -1) byPrize.db.push(num);
      else if (label.indexOf('nhất') !== -1) byPrize.n1.push(num);
      else if (label.indexOf('nhì') !== -1) byPrize.n2.push(num);
      else if (label.indexOf('ba') !== -1) byPrize.n3.push(num);
    });
    function countHits(pool) {
      return validTickets.filter(function (t) {
        return pool.indexOf(t) !== -1;
      }).length;
    }
    var topPool = byPrize.db.concat(byPrize.n1, byPrize.n2, byPrize.n3);
    var matchedTicketNums = validTickets
      .filter(function (t) {
        return topPool.indexOf(t) !== -1;
      })
      .map(function (t) {
        return parseInt(t, 10);
      })
      .filter(function (n) {
        return !isNaN(n);
      });
    var prize = '';
    var amount = 0;
    if (product === 'max3d') {
      var matchedSet = sets.find(function (s) {
        return validTickets.indexOf(String(((s && s.numbers) || []).join('') || '')) !== -1;
      });
      var lb = String((matchedSet && matchedSet.label) || '').toLowerCase();
      if (matchedSet) {
        if (lb.indexOf('đặc biệt') !== -1 || lb.indexOf('dac biet') !== -1) {
          prize = 'Giải Đặc biệt';
          amount = 1000000;
        } else if (lb.indexOf('nhất') !== -1) {
          prize = 'Giải Nhất';
          amount = 350000;
        } else if (lb.indexOf('nhì') !== -1) {
          prize = 'Giải Nhì';
          amount = 210000;
        } else if (lb.indexOf('ba') !== -1) {
          prize = 'Giải Ba';
          amount = 100000;
        }
      }
    } else {
      var t1 = validTickets[0];
      var t2 = validTickets[1];
      var hitDbOrdered = byPrize.db.length >= 2 && t1 === byPrize.db[0] && t2 === byPrize.db[1];
      var hitDbReverse = byPrize.db.length >= 2 && t1 === byPrize.db[1] && t2 === byPrize.db[0];
      if (hitDbOrdered) prize = 'Giải Đặc biệt';
      else if (hitDbReverse) prize = 'Giải Phụ Đặc biệt';
      else if (countHits(byPrize.n1) >= 2) prize = 'Giải Nhất';
      else if (countHits(byPrize.n2) >= 2) prize = 'Giải Nhì';
      else if (countHits(byPrize.n3) >= 2) prize = 'Giải Ba';
      else if (countHits(topPool) >= 2) prize = 'Giải Tư';
      else if (countHits(byPrize.db) >= 1) prize = 'Giải Năm';
      else if (countHits(byPrize.n1.concat(byPrize.n2, byPrize.n3)) >= 1) prize = 'Giải Sáu';
    }
    return { matched: matchedTicketNums, prize: prize, amount: amount };
  }

  function getVietlottNums() {
    if (state.product === 'lotto535') {
      return state.lottoSpec.length === 1 ? state.picker.concat(state.lottoSpec) : state.picker.slice();
    }
    if (state.product === 'mega' || state.product === 'power') return state.picker.slice();
    if (state.product === 'keno' && state.kenoTab === 'so') return state.picker.slice();
    if (state.product === 'max3d') {
      var d = state.slots
        .map(function (v) {
          return String(v).trim();
        })
        .filter(function (v) {
          return /^\d$/.test(v);
        });
      return d.length === 3 ? [parseInt(d.join(''), 10)] : [];
    }
    if (state.product === 'max3dpro') {
      var a = state.pro[0].map(function (v) {
        return String(v).trim();
      });
      var b = state.pro[1].map(function (v) {
        return String(v).trim();
      });
      var out = [];
      if (a.every(function (v) {
        return /^\d$/.test(v);
      }))
        out.push(parseInt(a.join(''), 10));
      if (b.every(function (v) {
        return /^\d$/.test(v);
      }))
        out.push(parseInt(b.join(''), 10));
      return out;
    }
    return [];
  }

  function parseViDate(text) {
    var parts = String(text || '').split('/');
    if (parts.length !== 3) return new Date();
    var parsed = new Date(Number(parts[2]), Number(parts[1]) - 1, Number(parts[0]));
    return isNaN(parsed.getTime()) ? new Date() : parsed;
  }

  function weekdayFromVi(s) {
    return parseViDate(s).getDay();
  }

  function daiOptions() {
    var w = weekdayFromVi(state.xsktDate);
    return XSKT_SCHEDULE[state.xsktRegion][w] || [];
  }

  function saveTicket(row) {
    try {
      var raw = localStorage.getItem(KEY);
      var arr = raw ? JSON.parse(raw) : [];
      arr.unshift(
        Object.assign({}, row, {
          createdAt: new Date().toISOString(),
        })
      );
      localStorage.setItem(KEY, JSON.stringify(arr.slice(0, 200)));
    } catch (e) {
      console.warn(e);
    }
  }

  function removeSavedTicket(createdAt) {
    if (!createdAt) return;
    try {
      var raw = localStorage.getItem(KEY);
      var arr = raw ? JSON.parse(raw) : [];
      var next = arr.filter(function (x) {
        return x.createdAt !== createdAt;
      });
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch (e) {
      console.warn(e);
    }
  }

  function loadKyList() {
    var p = state.product;
    if (['keno', 'mega', 'power', 'max3d', 'max3dpro', 'lotto535'].indexOf(p) === -1) return;
    fetchJSON(API_BASE + '/vietlott/' + p + '/list')
      .then(function (j) {
        if (j.success && Array.isArray(j.data)) state.kyList = j.data;
        else state.kyList = [];
        render();
      })
      .catch(function () {
        state.kyList = [];
        render();
      });
  }

  function togglePick(n, max, cap) {
    var arr = state.picker.slice();
    var i = arr.indexOf(n);
    if (i !== -1) arr.splice(i, 1);
    else if (arr.length < cap) arr.push(n);
    arr.sort(function (a, b) {
      return a - b;
    });
    state.picker = arr;
    render();
  }

  function toggleSpec(n) {
    var arr = state.lottoSpec.slice();
    var i = arr.indexOf(n);
    state.lottoSpec = i !== -1 ? [] : [n];
    render();
  }

  function gridHTML(total, pick, accent, flexKeno, wrapClass) {
    flexKeno = !!flexKeno;
    var maxSel = flexKeno ? 10 : pick;
    var minReady = flexKeno ? 1 : pick;
    var wrapCls = 'grid-pick' + (wrapClass ? ' ' + String(wrapClass) : '');
    var cells = [];
    for (var n = 1; n <= total; n++) {
      var sel = state.picker.indexOf(n) !== -1;
      var dis = state.picker.length >= maxSel && !sel;
      cells.push(
        '<button type="button" class="cell' +
          (sel ? ' sel' : '') +
          (dis ? ' dis' : '') +
          '" data-pick="' +
          n +
          '"' +
          (dis ? ' disabled' : '') +
          '>' +
          String(n).padStart(2, '0') +
          '</button>'
      );
    }
    var ready = state.picker.length >= minReady && state.picker.length <= maxSel;
    return (
      '<div class="' +
      wrapCls +
      '">' +
      cells.join('') +
      '</div><div class="sel-hint' +
      (ready ? ' ok' : '') +
      '">' +
      (ready
        ? 'Đã chọn số, bạn có thể Dò kết quả.'
        : flexKeno
          ? 'Vui lòng chọn từ 1 đến 10 số.'
          : 'Vui lòng chọn ' + pick + ' số để dò kết quả.') +
      '</div>'
    );
  }

  function lotto535HTML() {
    var main = gridHTML(35, 5, '', false, 'grid-lotto535-main');
    var spec = [];
    for (var n = 1; n <= 12; n++) {
      var sel = state.lottoSpec.indexOf(n) !== -1;
      var dis = state.lottoSpec.length >= 1 && !sel;
      spec.push(
        '<button type="button" class="cell' +
          (sel ? ' spec-sel' : '') +
          (dis ? ' dis' : '') +
          '" data-spec="' +
          n +
          '"' +
          (dis ? ' disabled' : '') +
          '>' +
          String(n).padStart(2, '0') +
          '</button>'
      );
    }
    var sr = state.lottoSpec.length === 1;
    var mr = state.picker.length === 5;
    return (
      '<p style="margin:8px 0 4px;font-size:13px;color:#666C76">⭐ Số đặc biệt (01-12)</p><div class="grid-pick grid-lotto535-spec">' +
      spec.join('') +
      '</div>' +
      main +
      (mr && sr ? '<div class="sel-hint ok">Đã chọn đủ số, bạn có thể Dò kết quả.</div>' : '')
    );
  }

  function slotsHTML(which) {
    var arr = which === 'pro0' ? state.pro[0] : which === 'pro1' ? state.pro[1] : state.slots;
    var out = ['<div class="slot-row">'];
    for (var i = 0; i < 3; i++) {
      out.push(
        '<input type="tel" maxlength="1" pattern="[0-9]*" inputmode="numeric" data-slot="' +
          which +
          '-' +
          i +
          '" value="' +
          (arr[i] || '').replace(/"/g, '&quot;') +
          '" />'
      );
    }
    out.push('</div>');
    return out.join('');
  }

  /** Bỏ tiền tố "Giải " trùng với nhãn giải ở phần kết quả chi tiết. */
  function formatPrizeDisplay(prize) {
    return String(prize == null ? '' : prize)
      .replace(/^Giải\s+/i, '')
      .trim();
  }

  function resultHTML() {
    if (!state.apiResult || !state.checkResult) return '';
    var cr = state.checkResult;
    var ar = state.apiResult;
    var my = getVietlottNums();
    if (state.channel === 'xskt') my = [];
    var win = (ar && ar.numbers) || [];
    var isText = state.product === 'keno' && cr.textMode;
    var lines =
      '<div class="result"><h3>Kết quả</h3><p style="color:#8A8F98;font-size:12px;margin:4px 0 0">Kỳ: ' +
      (ar.kySo || '—') +
      ' · Ngày: ' +
      (ar.drawDate || '—') +
      '</p>';
    lines +=
      '<div style="margin-top:10px;padding:10px;border-radius:8px;background:#F7F8FC"><div style="color:#6D7380;font-size:12px;font-weight:700">Kết luận</div><div style="margin-top:4px;font-weight:800;color:' +
      (cr.prize ? '#11845B' : '#303233') +
      '">' +
      (cr.prize ? 'Trúng' : 'Không trúng') +
      '</div>';
    if (cr.prize) lines += '<div style="margin-top:2px;font-size:12px;color:#7B818D">' + escapeHtml(formatPrizeDisplay(cr.prize)) + '</div>';
    lines += '</div>';
    if (isText) {
      var kmap = {
        chan: 'Chẵn',
        chan1112: 'Chẵn 11-12',
        hoachanle: 'Hòa Chẵn/Lẻ',
        le1112: 'Lẻ 11-12',
        le: 'Lẻ',
        lon: 'Lớn',
        hoalonnho: 'Hòa Lớn/Nhỏ',
        nho: 'Nhỏ',
      };
      lines +=
        '<div style="margin-top:10px;padding:10px;border-radius:8px;background:#F7F8FC;font-size:14px;font-weight:700">Lựa chọn của bạn: ' +
        escapeHtml(kmap[String(cr.textChoice)] || String(cr.textChoice || '')) +
        '</div>';
      var evenCount = win.filter(function (n) {
        return n % 2 === 0;
      }).length;
      lines +=
        '<div style="margin-top:10px;padding:10px;border-radius:8px;background:#F7F8FC"><div style="color:#8A8F98;font-size:11px;font-weight:700">Kết quả thống kê</div><div style="color:#7B818D;font-size:12px;font-weight:700">Chẵn/Lẻ: ' +
        evenCount +
        '/' +
        (win.length - evenCount) +
        ' · Lớn/Nhỏ: ' +
        win.filter(function (n) {
          return n >= 41 && n <= 80;
        }).length +
        '/' +
        win.filter(function (n) {
          return n >= 1 && n <= 40;
        }).length +
        '</div></div>';
    } else if (state.product === 'max3d' || state.product === 'max3dpro') {
      var sets = Array.isArray(ar.sets) ? ar.sets : [];
      var matched3d = cr.matched || [];
      var grouped = groupMax3dSetsForDisplay(sets);
      lines += '<div style="margin-top:10px;font-size:12px;font-weight:700;color:#6D7380">Kết quả quay thưởng</div>';
      grouped.forEach(function (g) {
        var numsHtml = g.nums
          .map(function (num) {
            var hit = matched3d.indexOf(Number(num)) !== -1;
            return (
              '<span style="color:' +
              (hit ? '#34C759' : '#303233') +
              ';font-weight:700">' +
              escapeHtml(num) +
              '</span>'
            );
          })
          .join('<span style="color:#C9CED8;font-weight:600"> · </span>');
        lines +=
          '<div style="display:flex;flex-wrap:nowrap;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid #EEF1F6;font-size:13px;overflow-x:auto;-webkit-overflow-scrolling:touch">' +
          '<span style="color:#727982;flex:0 0 auto;max-width:42%">' +
          escapeHtml(g.label) +
          '</span>' +
          '<span style="flex:1 1 auto;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums">' +
          numsHtml +
          '</span></div>';
      });
    } else if (win.length > 0) {
      var matched = my.filter(function (n) {
        return win.indexOf(n) !== -1;
      });
      lines +=
        '<div style="margin-top:10px;padding:10px;border-radius:8px;background:#F7F8FC"><div style="color:#8A8F98;font-size:11px;font-weight:700">Kết quả đối chiếu</div><div style="color:' +
        (matched.length > 0 ? '#34C759' : '#8A8F98') +
        ';font-weight:700">Trùng ' +
        matched.length +
        '/' +
        win.length +
        ' số' +
        (matched.length ? ' (' + matched.join(', ') + ')' : '') +
        '</div></div>';
      lines += '<div style="margin-top:10px;font-size:12px;font-weight:700;color:#6D7380">Số của bạn</div><div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">';
      my.forEach(function (n) {
        var hit = win.indexOf(n) !== -1;
        lines +=
          '<span style="width:34px;height:34px;border-radius:17px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;border:1px solid ' +
          (hit ? '#8875FF' : '#E2E6EF') +
          ';background:' +
          (hit ? '#8875FF' : '#F1F3F8') +
          ';color:' +
          (hit ? '#fff' : '#5D6470') +
          '">' +
          String(n).padStart(2, '0') +
          '</span>';
      });
      lines += '</div><div style="margin-top:10px;font-size:12px;font-weight:700;color:#6D7380">Số trúng thưởng</div><div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">';
      win.forEach(function (n) {
        var hit = my.indexOf(n) !== -1;
        lines +=
          '<span style="width:34px;height:34px;border-radius:17px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;border:1px solid ' +
          (hit ? '#34C759' : '#CFE3FF') +
          ';background:' +
          (hit ? '#34C759' : '#EAF3FF') +
          ';color:' +
          (hit ? '#fff' : '#2E7FD6') +
          '">' +
          String(n).padStart(2, '0') +
          '</span>';
      });
      lines += '</div>';
      if (typeof ar.powerNumber === 'number') {
        lines +=
          '<div style="margin-top:10px;font-size:12px;font-weight:700;color:#6D7380">' +
          (state.product === 'lotto535' ? 'Số đặc biệt' : 'Số đặc biệt (JP2)') +
          '</div><div style="display:flex;gap:6px;margin-top:6px"><span style="width:34px;height:34px;border-radius:17px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;border:1px solid ' +
          (my.indexOf(ar.powerNumber) !== -1 ? '#34C759' : '#CFE3FF') +
          ';background:' +
          (my.indexOf(ar.powerNumber) !== -1 ? '#34C759' : '#EAF3FF') +
          ';color:' +
          (my.indexOf(ar.powerNumber) !== -1 ? '#fff' : '#2E7FD6') +
          '">' +
          String(ar.powerNumber).padStart(2, '0') +
          '</span></div>';
      }
    }
    lines += '</div>';
    return lines;
  }

  function groupMax3dSetsForDisplay(sets) {
    if (!Array.isArray(sets) || sets.length === 0) return [];
    var groups = {};
    sets.forEach(function (s, idx) {
      var label = String((s && s.label) || 'Bộ ' + (idx + 1));
      var groupKey = label.replace(/\s*bộ\s*\d+/i, '').trim() || label;
      var numStr = String((s && s.numbers && s.numbers.join('')) || '');
      if (!groups[groupKey]) groups[groupKey] = [];
      if (numStr) groups[groupKey].push(numStr);
    });
    return Object.keys(groups).map(function (k) {
      return { label: k, nums: groups[k] };
    });
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderVietlott() {
    var acc = {
      keno: '#F5943A',
      mega: '#8875FF',
      power: '#5AA4F4',
      max3d: '#35E89E',
      max3dpro: '#20C784',
      lotto535: '#F5C840',
    }[state.product];
    var items = [
      { k: 'keno', l: 'Keno' },
      { k: 'mega', l: 'Mega 6/45' },
      { k: 'power', l: 'Power 6/55' },
      { k: 'max3d', l: 'Max 3D' },
      { k: 'max3dpro', l: 'Max 3D Pro' },
      { k: 'lotto535', l: 'Lotto 5/35' },
    ];
    var chips = items
      .map(function (it) {
        return (
          '<button type="button" class="product-chip' +
          (state.product === it.k ? ' on' : '') +
          '" data-product="' +
          it.k +
          '"><img src="' +
          LOGO_SRC[it.k] +
          '" alt="" class="product-chip-logo" />' +
          it.l +
          '</button>'
        );
      })
      .join('');
    var b = BANNERS[state.product] || BANNERS.keno;
    var kyBlock = '';
    if (['keno', 'mega', 'power', 'max3d', 'max3dpro', 'lotto535'].indexOf(state.product) !== -1) {
      kyBlock =
        '<label class="ky-row">📋 <select id="ky-select"><option value="">Mới nhất' +
        (state.kyList[0] ? ' (#' + state.kyList[0].kyso + ')' : '') +
        '</option>' +
        state.kyList
          .map(function (x) {
            return '<option value="' + escapeHtml(x.kyso) + '"' + (state.ky === x.kyso ? ' selected' : '') + '>Kỳ #' + escapeHtml(x.kyso) + ' · ' + escapeHtml(x.date) + '</option>';
          })
          .join('') +
        '</select></label>';
    }
    var body = '';
    if (state.product === 'keno') {
      body +=
        '<div class="keno-sub"><button type="button" class="' +
        (state.kenoTab === 'so' ? 'on' : '') +
        '" data-kenotab="so">Chọn số</button><button type="button" class="' +
        (state.kenoTab === 'text' ? 'on' : '') +
        '" data-kenotab="text">Chẵn/Lẻ/Lớn/Nhỏ</button></div>';
      if (state.kenoTab === 'text') {
        body +=
          '<div><span>Lớn/Nhỏ</span><div class="text-opts">' +
          ['lon', 'hoalonnho', 'nho']
            .map(function (k) {
              return '<button type="button" class="opt' + (state.kenoText === k ? ' on' : '') + '" data-ktext="' + k + '">' + { lon: 'Lớn', hoalonnho: 'Hòa Lớn Nhỏ', nho: 'Nhỏ' }[k] + '</button>';
            })
            .join('') +
          '</div></div>';
        body +=
          '<div style="margin-top:10px"><span>Chẵn/Lẻ</span><div class="text-opts">' +
          ['chan', 'chan1112', 'hoachanle', 'le1112', 'le']
            .map(function (k) {
              var lab = { chan: 'Chẵn', chan1112: 'Chẵn 11-12', hoachanle: 'Hòa', le1112: 'Lẻ 11-12', le: 'Lẻ' };
              return '<button type="button" class="opt' + (state.kenoText === k ? ' on' : '') + '" data-ktext="' + k + '">' + lab[k] + '</button>';
            })
            .join('') +
          '</div></div>';
      } else {
        body += gridHTML(80, 10, acc, true);
      }
    } else if (state.product === 'max3d') body += slotsHTML('m3');
    else if (state.product === 'max3dpro') body += '<div class="pro-row">' + slotsHTML('pro0') + '<span style="font-size:22px;font-weight:700;color:#565D69">-</span>' + slotsHTML('pro1') + '</div>';
    else if (state.product === 'mega') body += gridHTML(45, 6, acc);
    else if (state.product === 'power') body += gridHTML(55, 6, acc);
    else if (state.product === 'lotto535') body += lotto535HTML();

    return (
      '<div class="product-scroll">' +
      chips +
      '</div><p class="hint">Vuốt sang trái để xem thêm sản phẩm</p>' +
      kyBlock +
      '<div class="banner" style="background:' +
      b.bg +
      ';border-color:' +
      b.b +
      '"><div class="banner-logo"><img src="' +
      (LOGO_SRC[state.product] || LOGO_SRC.keno) +
      '" alt="" /></div><div><h2>' +
      escapeHtml(b.t) +
      '</h2><p>' +
      escapeHtml(b.n) +
      '</p><span class="tag" style="background:' +
      b.tg +
      ';color:' +
      b.tc +
      '">' +
      escapeHtml(b.tag) +
      '</span></div></div>' +
      body +
      MOMO_CONSENT_HTML +
      '<button type="button" class="btn-check" id="btn-check" style="background:' +
      acc +
      '"' +
      (state.loading ? ' disabled' : '') +
      '>' +
      (state.loading ? '<span class="spinner"></span>' : '') +
      (state.loading ? 'Đang dò...' : 'Dò kết quả') +
      '</button>' +
      resultHTML()
    );
  }

  function xsktDateSelectHTML() {
    var out = [];
    var now = new Date();
    for (var i = 0; i < 21; i++) {
      var d = new Date(now);
      d.setDate(now.getDate() - i);
      var text = d.toLocaleDateString('vi-VN');
      out.push(
        '<option value="' +
          escapeHtml(text) +
          '"' +
          (text === state.xsktDate ? ' selected' : '') +
          '>' +
          escapeHtml(text) +
          '</option>'
      );
    }
    return '<label style="display:block;margin-bottom:10px;font-size:13px;color:#6F7682">Ngày dò<select id="xskt-date" style="display:block;width:100%;margin-top:6px;height:40px;border-radius:10px;border:1px solid #E5E7EB;padding:0 10px;font-weight:600">' +
      out.join('') +
      '</select></label>';
  }

  function renderXskt() {
    var w = weekdayFromVi(state.xsktDate);
    var opts = daiOptions();
    if (opts.indexOf(state.xsktDai) === -1 && opts[0]) state.xsktDai = opts[0];
    var reg = { mb: 'Miền Bắc', mn: 'Miền Nam', mt: 'Miền Trung' };
    var wl = { 1: 'Thứ 2', 2: 'Thứ 3', 3: 'Thứ 4', 4: 'Thứ 5', 5: 'Thứ 6', 6: 'Thứ 7', 0: 'Chủ Nhật' };
    return (
      '<div class="region-row">' +
      ['mb', 'mn', 'mt']
        .map(function (r) {
          return (
            '<button type="button" class="' +
            (state.xsktRegion === r ? 'on' : '') +
            '" data-xregion="' +
            r +
            '">' +
            reg[r] +
            '</button>'
          );
        })
        .join('') +
      '</div>' +
      xsktDateSelectHTML() +
      '<div class="card"><div style="font-size:13px;color:#6F7682">' +
      wl[w] +
      ' · <strong style="color:#303233">' +
      escapeHtml(state.xsktDate) +
      '</strong></div><p style="font-size:12px;color:#6F7682;margin:8px 0 6px">Chọn nhà đài:</p><div class="dai-wrap">' +
      opts
        .map(function (d) {
          return (
            '<button type="button" class="' +
            (state.xsktDai === d ? 'on' : '') +
            '" data-xdai="' +
            escapeHtml(d) +
            '">' +
            escapeHtml(d) +
            '</button>'
          );
        })
        .join('') +
      '</div><p style="font-size:12px;color:#6F7682;margin:8px 0 4px">Nhập hoặc dán 6 số vé (một lần)</p><div class="ticket-box ticket-box-visible"><input id="xskt-in" class="xskt-ticket-visible" type="tel" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code" placeholder="······" value="' +
      escapeHtml(state.xsktTicket.replace(/\D/g, '')) +
      '" /></div><p id="xskt-ticket-hint" class="sel-hint' +
      (state.xsktTicket.replace(/\D/g, '').length === 6 ? ' ok' : '') +
      '" style="margin-top:8px">' +
      (state.xsktTicket.replace(/\D/g, '').length === 6 ? 'Đã nhập đủ 6 số.' : 'Nhập đủ 6 số để dò.') +
      '</p></div>' +
      MOMO_CONSENT_HTML +
      '<button type="button" class="btn-check" id="btn-check" style="background:#F5C840"' +
      (state.loading ? ' disabled' : '') +
      '>' +
      (state.loading ? '<span class="spinner"></span>' : '') +
      (state.loading ? 'Đang dò...' : 'Dò kết quả') +
      '</button>' +
      xsktResultHTML()
    );
  }

  function xsktResultHTML() {
    if (!state.apiResult || !state.checkResult || state.channel !== 'xskt') return '';
    var cr = state.checkResult;
    var ar = state.apiResult;
    var prizes = (ar.prizes || []).slice();
    function rank(lab) {
      var l = String(lab || '').toLowerCase();
      if (l.indexOf('đặc biệt') !== -1) return 0;
      if (l.indexOf('nhất') !== -1) return 1;
      if (l.indexOf('nhì') !== -1) return 2;
      if (l.indexOf('ba') !== -1) return 3;
      if (l.indexOf('tư') !== -1) return 4;
      if (l.indexOf('năm') !== -1) return 5;
      if (l.indexOf('sáu') !== -1) return 6;
      if (l.indexOf('bảy') !== -1) return 7;
      if (l.indexOf('tám') !== -1) return 8;
      return 99;
    }
    prizes.sort(function (a, b) {
      return rank(a.label) - rank(b.label);
    });
    var lines =
      '<div class="result"><h3>Kết quả</h3><p style="color:#8A8F98;font-size:12px">Ngày: ' +
      escapeHtml(ar.drawDate || '') +
      '</p><div style="margin-top:10px;padding:10px;border-radius:8px;background:#F7F8FC"><div style="font-weight:800;color:' +
      (cr.prize ? '#11845B' : '#303233') +
      '">' +
      (cr.prize ? 'Trúng' : 'Không trúng') +
      '</div>';
    if (cr.prize) lines += '<div style="font-size:12px;margin-top:4px">' + escapeHtml(formatPrizeDisplay(cr.prize)) + '</div>';
    lines += '</div><p style="margin-top:8px">Vé của bạn: ' + escapeHtml(state.xsktTicket) + '</p>';
    lines += '<div style="margin-top:10px;font-size:12px;font-weight:700;color:#6D7380">Danh sách số trúng</div>';
    prizes.forEach(function (p) {
      var win = cr.prize === p.label;
      lines +=
        '<div style="padding:8px;border-radius:8px;margin-top:4px;background:' +
        (win ? '#ECF9F1' : 'transparent') +
        ';border-bottom:1px solid #EEF1F6;display:flex;justify-content:space-between;gap:10px"><span style="font-weight:' +
        (win ? '800' : '600') +
        ';color:' +
        (win ? '#11845B' : '#727982') +
        ';min-width:86px;font-size:12px">' +
        escapeHtml(p.label) +
        '</span><span style="font-weight:700;text-align:right;flex:1;font-size:13px;color:' +
        (win ? '#11845B' : '#303233') +
        '">' +
        (p.numbers || [])
          .map(function (num) {
            var n = String(num).trim();
            return n === String(state.xsktTicket).trim() ? '★' + escapeHtml(n) + '★' : escapeHtml(n);
          })
          .join(' · ') +
        '</span></div>';
    });
    lines += '</div>';
    return lines;
  }

  function renderSaved() {
    var raw = localStorage.getItem(KEY);
    var arr = [];
    try {
      arr = raw ? JSON.parse(raw) : [];
    } catch (e) {
      arr = [];
    }
    var ch = state.channel;
    var list = arr.filter(function (x) {
      return x.channel === ch;
    });
    if (!list.length) return '<p style="color:#8A8F98">Chưa có lịch sử dò.</p>';
    var groups = {};
    list.forEach(function (it) {
      var dk = it.createdAt ? new Date(it.createdAt).toLocaleDateString('vi-VN') : 'Không rõ';
      if (!groups[dk]) groups[dk] = [];
      groups[dk].push(it);
    });
    var html = '';
    Object.keys(groups).forEach(function (dk) {
      html += '<div class="date-grp">' + (ch === 'xskt' ? 'Ngày ' : 'Kỳ ') + escapeHtml(dk) + '</div>';
      groups[dk].forEach(function (it) {
        var win = !!it.prize;
        var nums = Array.isArray(it.numbers)
          ? it.numbers
              .map(function (n) {
                return String(n).padStart(2, '0');
              })
              .join(' ')
          : it.ticketNumber || '';
        var ca = encodeURIComponent(String(it.createdAt || ''));
        html +=
          '<div class="saved-swipe-outer">' +
          '<div class="saved-swipe-delete"><button type="button" class="btn-saved-del" data-ca="' +
          ca +
          '">Xóa</button></div>' +
          '<div class="saved-swipe-front">' +
          '<div class="saved-card' +
          (win ? ' win' : '') +
          '"><div class="stripe"></div><div style="padding-left:8px"><div style="font-weight:800;font-size:14px;color:' +
          (win ? '#1E9E57' : '#6C63FF') +
          '">' +
          escapeHtml((it.label || '').toUpperCase()) +
          '</div><div style="font-weight:700;margin-top:2px">' +
          escapeHtml(nums || '—') +
          '</div>' +
          (win
            ? '<div style="color:#1E9E57;font-size:12px;font-weight:700;margin-top:4px">Trúng: ' + escapeHtml(formatPrizeDisplay(it.prize)) + '</div>'
            : '') +
          '</div></div></div></div>';
      });
    });
    return html;
  }

  function render() {
    var tab = state.tab;
    forEachNode(document.querySelectorAll('.tab-pill'), function (el) {
      el.classList.toggle('on', el.getAttribute('data-tab') === tab);
    });
    document.getElementById('panel-do').classList.toggle('hidden', tab !== 'do');
    document.getElementById('panel-luu').classList.toggle('hidden', tab !== 'luu');
    document.getElementById('nav-vl').classList.toggle('on', state.channel === 'vietlott');
    document.getElementById('nav-xskt').classList.toggle('on', state.channel === 'xskt');
    document.getElementById('bar-vl').classList.toggle('hidden', state.channel !== 'vietlott');
    document.getElementById('bar-xskt').classList.toggle('hidden', state.channel !== 'xskt');

    if (tab === 'luu') {
      document.getElementById('panel-luu').innerHTML = renderSaved();
      return;
    }
    var panelDoEl = document.getElementById('panel-do');
    var savedProductScroll = 0;
    if (tab === 'do' && state.channel === 'vietlott') {
      var scEl = panelDoEl.querySelector('.product-scroll');
      if (scEl) savedProductScroll = scEl.scrollLeft;
    }
    panelDoEl.innerHTML = state.channel === 'vietlott' ? renderVietlott() : renderXskt();
    if (tab === 'do' && state.channel === 'vietlott') {
      requestAnimationFrame(function () {
        var sc2 = panelDoEl.querySelector('.product-scroll');
        if (!sc2) return;
        if (savedProductScroll > 0) {
          sc2.scrollLeft = savedProductScroll;
        } else {
          var onChip = sc2.querySelector('.product-chip.on');
          if (onChip && typeof onChip.scrollIntoView === 'function') {
            try {
              onChip.scrollIntoView({ inline: 'center', block: 'nearest' });
            } catch (e) {
              onChip.scrollIntoView(true);
            }
          }
        }
      });
    }
  }

  function wire() {
    forEachNode(document.querySelectorAll('.tab-pill'), function (el) {
      el.addEventListener('click', function () {
        state.tab = el.getAttribute('data-tab');
        render();
      });
    });
    document.getElementById('nav-vl').addEventListener('click', function () {
      state.channel = 'vietlott';
      state.tab = 'do';
      loadKyList();
      render();
    });
    document.getElementById('nav-xskt').addEventListener('click', function () {
      state.channel = 'xskt';
      state.tab = 'do';
      render();
    });
    document.getElementById('nav-scan').addEventListener('click', function () {
      toast('Tính năng đang được phát triển');
    });
    var panelDo = document.getElementById('panel-do');
    panelDo.addEventListener('click', function (e) {
      var t = findClickTarget(e.target, panelDo);
      if (!t) return;
      if (t.getAttribute('data-product')) {
        state.product = t.getAttribute('data-product');
        state.picker = [];
        state.lottoSpec = [];
        state.slots = ['', '', ''];
        state.pro = [
          ['', '', ''],
          ['', '', ''],
        ];
        state.ky = '';
        state.kenoTab = 'so';
        state.kenoText = null;
        state.apiResult = state.checkResult = null;
        loadKyList();
        render();
        return;
      }
      if (t.getAttribute('data-kenotab')) {
        state.kenoTab = t.getAttribute('data-kenotab');
        state.kenoText = null;
        state.apiResult = state.checkResult = null;
        render();
        return;
      }
      if (t.getAttribute('data-ktext')) {
        state.kenoText = t.getAttribute('data-ktext');
        state.apiResult = state.checkResult = null;
        render();
        return;
      }
      if (t.getAttribute('data-pick')) {
        var n = Number(t.getAttribute('data-pick'));
        var cap = 6;
        var tot = 45;
        if (state.product === 'power') tot = 55;
        if (state.product === 'keno') {
          cap = 10;
          tot = 80;
        }
        if (state.product === 'lotto535') {
          cap = 5;
          tot = 35;
        }
        togglePick(n, tot, cap);
        state.apiResult = state.checkResult = null;
        render();
        return;
      }
      if (t.getAttribute('data-spec')) {
        toggleSpec(Number(t.getAttribute('data-spec')));
        state.apiResult = state.checkResult = null;
        render();
        return;
      }
      if (t.getAttribute('data-xregion')) {
        state.xsktRegion = t.getAttribute('data-xregion');
        var w = weekdayFromVi(state.xsktDate);
        var o = XSKT_SCHEDULE[state.xsktRegion][w] || [];
        state.xsktDai = o[0] || state.xsktDai;
        state.apiResult = state.checkResult = null;
        render();
        return;
      }
      if (t.getAttribute('data-xdai')) {
        state.xsktDai = t.getAttribute('data-xdai');
        state.apiResult = state.checkResult = null;
        render();
        return;
      }
      if (t.id === 'btn-check') void doCheck();
    });
    panelDo.addEventListener('change', function (e) {
      var t = e.target;
      if (t.id === 'ky-select') {
        state.ky = t.value;
        state.apiResult = state.checkResult = null;
        render();
      }
      if (t.id === 'xskt-date') {
        state.xsktDate = t.value;
        var w = weekdayFromVi(state.xsktDate);
        var o = XSKT_SCHEDULE[state.xsktRegion][w] || [];
        if (o.indexOf(state.xsktDai) === -1) state.xsktDai = o[0] || state.xsktDai;
        state.apiResult = state.checkResult = null;
        render();
      }
    });
    panelDo.addEventListener('focusin', function (e) {
      var t = e.target;
      if (!t || !t.getAttribute || t.getAttribute('data-slot') == null) return;
      var val = String(t.value || '');
      if (!val.length) return;
      setTimeout(function () {
        try {
          t.setSelectionRange(0, val.length);
        } catch (err) {
          if (typeof t.select === 'function') t.select();
        }
      }, 0);
    });
    panelDo.addEventListener('input', function (e) {
      var t = e.target;
      var slot = t.getAttribute('data-slot');
      if (slot) {
        var v = String(t.value).replace(/\D/g, '').slice(0, 1);
        t.value = v;
        var parts = slot.split('-');
        var which = parts[0];
        var idx = Number(parts[1]);
        if (which === 'm3') state.slots[idx] = v;
        else if (which === 'pro0') state.pro[0][idx] = v;
        else if (which === 'pro1') state.pro[1][idx] = v;
        state.apiResult = state.checkResult = null;
        if (v.length === 1) {
          var nextKey = null;
          if (which === 'm3' && idx < 2) nextKey = which + '-' + (idx + 1);
          else if (which === 'pro0' && idx < 2) nextKey = which + '-' + (idx + 1);
          else if (which === 'pro0' && idx === 2) nextKey = 'pro1-0';
          else if (which === 'pro1' && idx < 2) nextKey = which + '-' + (idx + 1);
          if (nextKey) {
            var nextInp = panelDo.querySelector('[data-slot="' + nextKey + '"]');
            if (nextInp) {
              setTimeout(function () {
                nextInp.focus();
                try {
                  nextInp.setSelectionRange(0, nextInp.value.length);
                } catch (err) {
                  if (typeof nextInp.select === 'function') nextInp.select();
                }
              }, 0);
            }
          }
        }
      }
      if (t.id === 'xskt-in') {
        var digits = String(t.value).replace(/\D/g, '').slice(0, 6);
        state.xsktTicket = digits;
        if (t.value !== digits) t.value = digits;
        state.apiResult = state.checkResult = null;
        var res = panelDo.querySelector('.result');
        if (res) res.remove();
        var hint = document.getElementById('xskt-ticket-hint');
        if (hint) {
          hint.classList.toggle('ok', digits.length === 6);
          hint.textContent = digits.length === 6 ? 'Đã nhập đủ 6 số.' : 'Nhập đủ 6 số để dò.';
        }
      }
    });
    var panelLuu = document.getElementById('panel-luu');
    var swipeDelW = 76;
    var swipeRow = null;
    function closestSwipeFront(fromEl) {
      var el = fromEl;
      while (el && el !== panelLuu) {
        if (el.nodeType === 1 && el.classList && el.classList.contains('saved-swipe-front')) return el;
        el = el.parentElement;
      }
      return null;
    }
    function resetSavedSwipeExcept(keep) {
      forEachNode(panelLuu.querySelectorAll('.saved-swipe-front'), function (f) {
        if (f !== keep) {
          f.style.transition = '';
          f.style.transform = '';
        }
      });
    }
    panelLuu.addEventListener('click', function (e) {
      var el = e.target;
      while (el && el !== panelLuu) {
        if (el.nodeType === 1 && el.classList && el.classList.contains('btn-saved-del')) {
          var rawCa = el.getAttribute('data-ca');
          if (rawCa) removeSavedTicket(decodeURIComponent(rawCa));
          render();
          e.preventDefault();
          return;
        }
        el = el.parentElement;
      }
    });
    panelLuu.addEventListener(
      'touchstart',
      function (e) {
        var front = closestSwipeFront(e.target);
        if (!front) return;
        var touch = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
        if (!touch) return;
        swipeRow = { front: front, startX: touch.clientX, startY: touch.clientY, lastDx: 0, active: true };
        front.style.transition = 'none';
        resetSavedSwipeExcept(front);
      },
      { passive: true }
    );
    panelLuu.addEventListener(
      'touchmove',
      function (e) {
        if (!swipeRow || !swipeRow.active || !swipeRow.front) return;
        var touch = e.touches && e.touches[0];
        if (!touch) return;
        var dx = swipeRow.startX - touch.clientX;
        var dy = Math.abs(touch.clientY - swipeRow.startY);
        if (dy > 14 && dy > Math.abs(dx) * 1.15) {
          swipeRow.active = false;
          swipeRow.front.style.transition = '';
          swipeRow.front.style.transform = '';
          swipeRow = null;
          return;
        }
        if (dx > 0) {
          swipeRow.lastDx = dx;
          swipeRow.front.style.transform = 'translateX(' + -Math.min(dx, swipeDelW) + 'px)';
          if (dx > 6) e.preventDefault();
        }
      },
      { passive: false }
    );
    function endSavedSwipe() {
      if (!swipeRow || !swipeRow.front) {
        swipeRow = null;
        return;
      }
      var front = swipeRow.front;
      var dx = swipeRow.lastDx || 0;
      swipeRow = null;
      front.style.transition = '';
      if (dx > 34) front.style.transform = 'translateX(-' + swipeDelW + 'px)';
      else front.style.transform = '';
    }
    panelLuu.addEventListener('touchend', endSavedSwipe, { passive: true });
    panelLuu.addEventListener('touchcancel', endSavedSwipe, { passive: true });
  }

  function doCheck() {
    if (state.loading) return;
    if (state.channel === 'xskt') {
      var xd = state.xsktTicket.replace(/\D/g, '');
      if (xd.length !== 6) {
        toast('Vui lòng nhập đủ 6 số vé!');
        return;
      }
      state.loading = true;
      render();
      fetchXskt(state.xsktDai, state.xsktDate)
        .then(function (data) {
          var check = checkXSKTTicket(state.xsktTicket, data);
          state.apiResult = data;
          state.checkResult = check;
          saveTicket({
            channel: 'xskt',
            product: 'xskt',
            label: 'XSKT · ' + state.xsktDai,
            ticketNumber: state.xsktTicket,
            dai: state.xsktDai,
            drawDate: state.xsktDate,
            frequency: 'once',
            prize: check.prize || '',
            matched: check.matched ? [1] : [],
          });
        })
        .catch(function (err) {
          toast(err.message || String(err));
        })
        .finally(function () {
          state.loading = false;
          render();
        });
      return;
    }

    var msg = '';
    var ok = false;
    if (state.product === 'lotto535') {
      if (state.lottoSpec.length !== 1) {
        toast('Vui lòng chọn số đặc biệt cho Lotto 5/35!');
        return;
      }
      if (state.picker.length !== 5) {
        toast('Vui lòng chọn đủ 5 số!');
        return;
      }
      ok = true;
    } else if (state.product === 'keno' && state.kenoTab === 'text') {
      ok = state.kenoText != null;
      msg = 'Vui lòng chọn kiểu chơi Keno!';
    } else if (state.product === 'keno' && state.kenoTab === 'so') {
      var f = state.picker.length;
      ok = f >= 1 && f <= 10;
      msg = 'Vui lòng chọn từ 1 đến 10 số!';
    } else if (state.product === 'mega' || state.product === 'power') {
      ok = state.picker.length === 6;
      msg = 'Vui lòng chọn đủ 6 số!';
    } else if (state.product === 'max3d') {
      ok = state.slots.filter(Boolean).length === 3;
      msg = 'Vui lòng nhập đủ 3 chữ số!';
    } else if (state.product === 'max3dpro') {
      ok = state.pro[0].every(Boolean) && state.pro[1].every(Boolean);
      msg = 'Vui lòng nhập đủ cả 2 bộ số!';
    }

    if (!ok && msg) {
      toast(msg);
      return;
    }
    if (!ok) {
      toast('Chưa đủ thông tin để dò.');
      return;
    }

    state.loading = true;
    render();
    var kyApi = state.ky.trim() || undefined;

    function afterVietlott(result) {
      var drawId = result.kySo || state.ky;
      if (state.product === 'max3d' || state.product === 'max3dpro') {
        var m = max3dCheck(state.product, result, state.slots.slice(), state.pro);
        state.apiResult = result;
        state.checkResult = m;
        saveTicket({
          channel: 'vietlott',
          product: state.product,
          label: state.product.toUpperCase() + ' · Max3D',
          numbers: getVietlottNums(),
          drawId: drawId,
          frequency: 'every',
          prize: m.prize || '',
          matched: m.matched || [],
        });
        return;
      }
      if (state.product === 'keno' && state.kenoTab === 'text' && state.kenoText) {
        var nums = result.numbers || [];
        var kt = evaluateKenoText(state.kenoText, nums);
        state.apiResult = result;
        state.checkResult = {
          matched: kt.isWin ? [1] : [],
          prize: kt.prize,
          amount: kt.amount,
          textMode: true,
          textChoice: state.kenoText,
          textSummary: kt.summary,
          drawId: drawId,
        };
        saveTicket({
          channel: 'vietlott',
          product: 'keno',
          label: 'Keno · ' + state.kenoText,
          kenoTextChoice: state.kenoText,
          drawId: drawId,
          frequency: 'every',
          prize: kt.prize || '',
          matched: kt.isWin ? [1] : [],
        });
        return;
      }
      var myNums =
        state.product === 'lotto535'
          ? state.picker.concat(state.lottoSpec)
          : state.product === 'keno'
            ? state.picker
            : state.picker;
      var r2 = Object.assign({}, result, { kySo: result.kySo || state.ky });
      var check = checkVietlottTicket(myNums, r2, state.product);
      state.apiResult = r2;
      state.checkResult = Object.assign({}, check, { drawId: drawId });
      saveTicket({
        channel: 'vietlott',
        product: state.product,
        label: state.product.toUpperCase(),
        numbers: getVietlottNums(),
        drawId: drawId,
        frequency: 'every',
        prize: check.prize || '',
        matched: check.matched || [],
      });
    }

    fetchVietlott(state.product, kyApi)
      .then(afterVietlott)
      .catch(function (err) {
        toast(err.message || String(err));
        state.apiResult = state.checkResult = null;
      })
      .finally(function () {
        state.loading = false;
        render();
      });
  }

  function boot() {
    try {
      wire();
      loadKyList();
      render();
    } catch (err) {
      console.error('[doxoso web]', err);
      var p = document.getElementById('panel-do');
      if (p) {
        p.innerHTML =
          '<p style="padding:16px;color:#D64545;font-weight:600">Không tải được giao diện dò số. Thử mở bằng Chrome/Safari hoặc tải lại trang (Ctrl+F5).</p><p style="padding:0 16px 16px;color:#6F7682;font-size:13px">Lỗi kỹ thuật: ' +
          escapeHtml(String(err && err.message ? err.message : err)) +
          '</p>';
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
