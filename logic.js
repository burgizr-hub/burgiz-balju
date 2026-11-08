// 발주 정리 로직 — apps/balju/build.py 를 그대로 옮긴 것. 규칙을 바꾸면 build.py 와 같이 바꾼다.
// 입력: 발주앱 daily_orders(그날 전체 차수) + 설정(vendors.json·cart_map.json)
// 출력: 페이지에 그릴 DATA (template.html 과 같은 모양)
const WEEK = "월화수목금토일";

function classify(item, cfg) {
  if (item.name in cfg.item_rules) return cfg.item_rules[item.name];
  return cfg.group_rules[item.top] || "확인필요";
}

// 같은 매장의 1차·2차 발주를 품목별로 합친다. 여러 차수에 같은 품목이 있으면 중복 가능성을 표시한다
function merge(orders, branch) {
  const merged = new Map();
  for (const o of orders) {
    if (o.branch !== branch) continue;
    for (const it of o.items) {
      const key = it.name + "|" + it.unit;
      if (!merged.has(key)) merged.set(key, { ...it, qty: 0, memos: [], seqs: [] });
      const m = merged.get(key);
      m.qty += it.qty;
      m.seqs.push({ seq: o.seq, qty: it.qty });
      if (it.memo) m.memos.push(it.memo);
    }
  }
  return [...merged.values()];
}

function cartUrl(p) {
  if (p.url) return p.url;
  if (p.site === "쿠팡" && p.productId) return `https://www.coupang.com/vp/products/${p.productId}?itemId=${p.itemId}&vendorItemId=${p.vendorItemId}`;
  return null;
}
const searchUrl = (site, q) => site === "네이버"
  ? `https://msearch.shopping.naver.com/search/all?query=${encodeURIComponent(q)}`
  : `https://www.coupang.com/np/search?q=${encodeURIComponent(q)}`;

function attachCart(table, cmap) {
  for (const [k, rows] of ["인터넷발주", "네이버", "강낭콩워터", "제작품"].flatMap(k => Object.entries(table[k] || {}).map(([, rows]) => [k, rows]))) {
    for (const it of rows) {
      const p = cmap[it.name];
      if (!p) { if (k === "인터넷발주") it.cart = { status: "manual", search: searchUrl("쿠팡", it.name) }; continue; }
      it.cart = {
        status: "link", site: p.site, product: p.name, url: cartUrl(p) || searchUrl(p.site, p.name),
        buy: it.stockOnly ? null : it.qty || 1, check: !!p.check, alt: p.alt || null,
        search: p.search ? searchUrl(p.site, p.search) : null,
        sub: p.substitute ? { name: p.substitute.name, url: cartUrl({ site: p.site, ...p.substitute }) } : null,
      };
    }
  }
}

const addDays = (day, n) => { const d = new Date(day + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const weekday = day => (new Date(day + "T00:00:00Z").getUTCDay() + 6) % 7; // 월=0 … 일=6

// 코카콜라 자동 계산: 월·목 아침 발주. 재고는 전날(일·수) 직원 기록 → 소진분 빼고 목표까지 채움 (박스 올림)
function cokePlan(day, raw, prevRaw, cfg) {
  const plan = cfg.coke_plan;
  if (!plan) return null;
  const wd = weekday(day);
  let orderDay, src, srcDay;
  if (plan.order_weekdays.includes(wd)) { orderDay = day; src = prevRaw; srcDay = addDays(day, -1); }
  else if (plan.order_weekdays.includes((wd + 1) % 7)) { orderDay = addDays(day, 1); src = raw; srcDay = day; }
  else return null;
  const out = { orderDay, orderLabel: `${+orderDay.slice(5, 7)}/${+orderDay.slice(8)}(${WEEK[weekday(orderDay)]})`, srcDay, branches: {} };
  for (const br of cfg.branches) {
    const orders = (src?.orders || []).filter(o => o.branch === br);
    const stock = {};
    for (const o of orders) for (const it of o.items) if (it.name in plan.targets && it.stock != null) stock[it.name] = it.stock; // 마지막 차수 값
    const rows = [], missing = [];
    for (const [name, target] of Object.entries(plan.targets)) {
      if (stock[name] == null) { missing.push(name); continue; }
      const est = Math.max(0, stock[name] - (plan.usage[name] || 0));
      const need = Math.ceil(target - est - 1e-9);
      rows.push({ name, stock: stock[name], est, target, qty: need > 0 ? need : 0, unit: plan.unit });
    }
    out.branches[br] = { submitted: orders.length > 0, rows, missing };
  }
  return out;
}

function buildData(day, raw, cfg, cmap, prevRaw) {
  const d = new Date(day + "T00:00:00");
  const wd = (d.getDay() + 6) % 7; // 월=0 … 일=6 (파이썬 weekday 와 같게)
  const allBranches = [...new Set(raw.orders.map(o => o.branch))].sort();
  const table = Object.fromEntries(cfg.vendors.map(v => [v.key, {}]));
  const stock = Object.fromEntries(cfg.vendors.map(v => [v.key, {}]));

  for (const br of allBranches) {
    for (const it of merge(raw.orders, br)) {
      const vk = classify(it, cfg);
      // 탄방·어은만 발주 대상. 다른 매장(관평·대흥)은 어반부처스 번·패티만 참고로 반영
      if (!cfg.branches.includes(br) && vk !== "어반부처스") continue;
      const memo = it.memos.join(" / ") || null;
      if (it.mandatory && vk === "인터넷발주") {
        // 펩시제로처럼 쿠팡에서 사는 필수 품목은 재고표가 아니라 인터넷발주 칸에 재고와 함께 넣는다
        (table[vk][br] ||= []).push({ name: it.name, qty: 0, unit: it.unit, memo, stock: it.stock, stockOnly: true });
        continue;
      }
      if (it.mandatory) {
        (stock[vk][br] ||= []).push({ name: it.name, stock: it.stock, unit: it.unit, memo });
        continue;
      }
      const row = { name: it.name, qty: it.qty, unit: it.unit, memo };
      const rule = (cfg.check_defaults || {})[it.name];
      if (rule && !row.qty) {
        // ✔만 체크된 품목 → 정해진 기본 발주량 (금요일 발주 = 토요일 입고분은 qty_sat)
        row.qty = wd === 4 && rule.qty_sat != null ? rule.qty_sat : rule.qty;
        if (rule.name) row.name = rule.name;
        if (rule.unit != null) row.unit = rule.unit;
      }
      const qr = (cfg.qty_rules || {})[it.name];
      if (qr && row.qty) {
        if (row.qty < qr.min) row.qty = qr.min; // 예: 버섯 1kg → 2kg
        if (row.qty >= qr.review_from) row.warn = `${row.qty}${qr.unit || row.unit} — 사장님 검수 필요`;
        if (qr.unit) row.unit = qr.unit;
      }
      if (it.name === "양파" && it.qty && row.name === "양파") {
        row.warn = `직원 입력 ${it.qty}${it.unit} — 깐양파 수량 확인 필요`;
      }
      const qs = it.seqs;
      if (qs.length > 1) {
        const t = qs.map(s => `${s.seq}차 ${s.qty || "✔"}`).join(" + ");
        row.warn = (row.warn ? row.warn + " · " : "") + `${t} 합산 — 중복인지 확인`;
      }
      row.name = (cfg.send_names || {})[row.name] || row.name;
      (table[vk][br] ||= []).push(row);
    }
  }
  attachCart(table, cmap);

  const memos = raw.orders.filter(o => o.memo).map(o => ({ branch: o.branch, seq: o.seq, memo: o.memo }));
  const submitted = {}, times = {};
  for (const o of raw.orders) {
    submitted[o.branch] = (submitted[o.branch] || 0) + 1;
    (times[o.branch] ||= []).push(new Date(o.created_at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false }));
  }
  return {
    date: day, label: `${d.getMonth() + 1}/${d.getDate()}(${WEEK[wd]})`, fetched_at: raw.fetched_at,
    branches: cfg.branches, submitted, times, vendors: cfg.vendors, table,
    stock: Object.fromEntries(Object.entries(stock).filter(([, v]) => Object.keys(v).length)), memos,
    coke: cokePlan(day, raw, prevRaw, cfg),
    stockLinks: Object.fromEntries(Object.entries(cmap).filter(([n]) => n in (cfg.item_rules || {})).map(([n, p]) => [n, cartUrl(p)]).filter(([, u]) => u)),
  };
}

// 발주앱 DB 읽기 (apps/balju/fetch_orders.js 와 같은 쿼리, 읽기 전용)
async function fetchOrders(sb, day) {
  const q = async (p) => { const { data, error } = await p; if (error) throw new Error(error.message); return data; };
  const [br, ord, inv, grp] = await Promise.all([
    q(sb.from("branches").select("id,name")),
    q(sb.from("daily_orders").select("*").eq("order_date", day).order("created_at")),
    q(sb.from("inventory_items").select("branch_id,name,group,order_mandatory")),
    q(sb.from("item_groups").select("branch_id,name,parent_group")),
  ]);
  const nm = Object.fromEntries(br.map(b => [b.id, b.name]));
  const parent = {};
  grp.forEach(g => { parent[g.branch_id + "|" + g.name] = g.parent_group; });
  const top = (b, g) => { let x = g; for (let i = 0; i < 5 && parent[b + "|" + x]; i++) x = parent[b + "|" + x]; return x; };
  const groupOf = {}, mand = {};
  inv.forEach(i => { groupOf[i.branch_id + "|" + i.name] = i.group; mand[i.branch_id + "|" + i.name] = !!i.order_mandatory; });
  return {
    date: day, fetched_at: new Date().toISOString(),
    orders: ord.map(o => ({
      branch: nm[o.branch_id], seq: o.seq, created_at: o.created_at, memo: o.general_memo,
      items: (o.items || []).map(i => {
        const g = groupOf[o.branch_id + "|" + i.name] || null;
        return { name: i.name, qty: i.orderQuantity || 0, unit: i.unit || "", stock: i.currentStock ?? null,
          memo: i.memo || null, mandatory: !!mand[o.branch_id + "|" + i.name], group: g, top: g ? top(o.branch_id, g) : null };
      }),
    })),
  };
}

if (typeof module !== "undefined") module.exports = { buildData, merge, classify, cokePlan, addDays, weekday };
