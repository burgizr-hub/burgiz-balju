// 사장님 폰용 발주 정리 앱. 발주앱 계정으로 로그인 → 그날 발주를 읽어 거래처별로 정리.
// 화면 구성은 apps/balju/template.html 과 같다 (보낼 메시지 → 직접 처리 → 재고 → 메모).
const SUPABASE_URL = "https://zkqfvabdtskqzjuipnph.supabase.co";
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InprcWZ2YWJkdHNrcXpqdWlwbnBoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg2ODIxOTEsImV4cCI6MjEwNDI1ODE5MX0.qA0bmSc3NjDm5NMNnMN9FXoU-_pkpSOoXeVa8ZZn84c"; // 발주앱이 쓰는 공개(anon) 키. 데이터는 로그인해야 읽힘(RLS)
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON, { auth: { persistSession: true, autoRefreshToken: true } });
const app = document.getElementById("app");

const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const short = b => b.replace(/점$/, "");
const qtyText = it => it.qty ? `${it.qty}${it.unit}` : "✔";
const line = it => `${it.name} ${qtyText(it)}${it.memo ? ` (${it.memo})` : ""}`;
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
};
const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const shiftDay = (day, n) => { const d = new Date(day + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

let CFG = null, CMAP = null, DATA = null;
let DAY = (location.hash.match(/\d{4}-\d{2}-\d{2}/) || [kstToday()])[0];

// ---------- 설정(거래처 번호·규칙) 복호화: 사장님 계정으로 로그인해야 열림 ----------
const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function loadConfig(uid) {
  const enc = await (await fetch("config.enc?v=" + Date.now(), { cache: "no-store" })).json();
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("burgiz-balju-v1:" + uid));
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(enc.iv) }, key, b64(enc.ct));
  const c = JSON.parse(new TextDecoder().decode(pt));
  CFG = c.vendors; CMAP = c.cart_map.items;
}

// ---------- 로그인 ----------
function showLogin(msg) {
  app.innerHTML = `<header><h1>버기즈 발주</h1><div class="note">발주앱과 같은 계정으로 로그인하세요. 한 번 로그인하면 계속 유지됩니다.</div></header>
    <form class="login card"><input name="id" autocomplete="username" inputmode="tel" placeholder="아이디 (전화번호)" required>
    <input name="pw" type="password" autocomplete="current-password" placeholder="비밀번호" required>
    <button type="submit">로그인</button>${msg ? `<div class="err">${esc(msg)}</div>` : ""}</form>`;
  app.querySelector("form").onsubmit = async e => {
    e.preventDefault();
    const f = e.currentTarget;
    let id = f.id.value.trim();
    if (!id.includes("@")) id = id.replace(/\D/g, "") + "@burgiz.co.kr"; // 발주앱은 전화번호@burgiz.co.kr 형식
    f.querySelector("button").textContent = "로그인 중…";
    const { error } = await sb.auth.signInWithPassword({ email: id, password: f.pw.value });
    if (error) return showLogin("로그인 실패: " + error.message);
    start();
  };
}

// ---------- 화면 조각 ----------
const tagClass = b => b.startsWith("탄방") ? "tan" : b.startsWith("어은") ? "eun" : "etc";
const storeTag = b => `<span class="store-tag ${tagClass(b)}">${esc(short(b))}</span>`;

function smsMessage(rows, branches, single, format, inline) {
  if (single) {
    const items = rows[single].map(line).join("\n");
    return format ? format.replace("{branch}", short(single)).replace("{items}", items) : items;
  }
  const body = inline ? branches.filter(b => rows[b]).flatMap(b => rows[b].map(it => `${short(b)} ${line(it)}`)).join("\n") : null;
  if (body) return format ? format.replace("{items}", body) : body;
  return branches.filter(b => rows[b]).map(b => `${short(b)}\n` + rows[b].map(line).join("\n")).join("\n\n");
}

function copy(btn, text) {
  const done = () => { btn.textContent = "복사됨 ✓"; btn.classList.add("done"); };
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, () => {});
}

function linkBtn(url, label, main) {
  const k = `open:${DAY}:${url}`;
  return `<a href="${esc(url)}" target="_blank" rel="noopener" data-k="${esc(k)}" class="${main ? "main" : ""} ${store.get(k) ? "visited" : ""}">${esc(label)}</a>`;
}

// 거래처 앱 바로가기: 아이폰 단축어(앱 열기)를 실행한다. 단축어 이름 = vendors.json app.shortcut
// url이 있으면 앱의 유니버설 링크(쿠팡처럼 바로 열림), 없으면 아이폰 단축어 경유(확인 팝업 1번)
const appBtn = a => !a ? "" : a.url
  ? `<a class="btn ghost" href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.label)}</a>`
  : `<a class="btn ghost" href="shortcuts://run-shortcut?name=${encodeURIComponent(a.shortcut)}">${esc(a.label)}</a>`;

function smsCard(title, phone, text, sub) {
  const c = document.createElement("div");
  c.className = "card";
  const digits = phone ? phone.replace(/-/g, "") : "";
  const sentKey = `sent:${DAY}:${title}`;
  c.innerHTML = `<div class="card-head"><h3>${esc(title)}</h3>${phone ? `<span class="phone">${phone}</span>` : ""}</div>
    ${sub || ""}<textarea aria-label="${esc(title)} 발주 문자"></textarea>
    <div class="actions"><button type="button" class="ghost copy">복사</button>
    ${digits ? `<a class="btn sms" href="#">${store.get(sentKey) ? "문자 다시 열기" : "문자 보내기"}</a>` : ""}</div>`;
  const ta = c.querySelector("textarea");
  ta.value = text;
  c.querySelector(".copy").onclick = e => copy(e.currentTarget, ta.value);
  const sms = c.querySelector(".sms");
  if (sms) {
    const sync = () => { sms.href = `sms:${digits}&body=${encodeURIComponent(ta.value)}`; };
    ta.addEventListener("input", sync); sync();
    sms.addEventListener("click", () => { store.set(sentKey, true); sms.textContent = "문자 다시 열기"; });
  }
  return c;
}

function rowHTML(it) {
  const det = [];
  if (it.memo) det.push(`<span class="memo">메모: ${esc(it.memo)}</span>`);
  if (it.warn) det.push(`<span class="flag">⚠ ${esc(it.warn)}</span>`);
  const c = it.cart;
  if (c && c.status === "manual") det.push(`<span>연결된 상품 없음 — 직접 주문</span><span class="links">${linkBtn(c.search, "쿠팡에서 검색")}</span>`);
  else if (c) {
    det.push(`<span>${esc(c.product)}</span>`);
    if (c.check) det.push(`<span class="flag">상품 확인${c.alt ? ` · ${esc(c.alt)}` : ""}</span>`);
    det.push(`<span class="links">${linkBtn(c.url, `${c.site || "쿠팡"} 열기${c.buy ? ` · ${c.buy}개` : ""}`, true)}${c.search ? linkBtn(c.search, "최저가 검색") : ""}${c.sub ? linkBtn(c.sub.url, "없으면 " + c.sub.name.split(",")[0]) : ""}</span>`);
  }
  const q = it.stockOnly ? `<span class="q${it.stock === 0 ? " zero" : ""}">재고 ${it.stock ?? "미입력"}</span>` : `<span class="q">${esc(qtyText(it))}</span>`;
  return `<div class="row"><span class="nm">${esc(it.name)}</span>${q}${det.length ? `<div class="det">${det.join("")}</div>` : ""}</div>`;
}

function listCard(v, rows, warn) {
  const c = document.createElement("div");
  c.className = "card" + (warn ? " warn" : "");
  let note = v.note;
  if (v.key === "인터넷발주") note = "버튼을 누르면 쿠팡 앱에서 상품이 열립니다. 매장별 배송지로 나눠 주문하세요.";
  const parts = Object.entries(rows).map(([b, items]) => `<div class="store">${storeTag(b)}${items.map(rowHTML).join("")}</div>`).join("");
  let extra = "";
  if (v.kind === "office") {
    c.dataset.txt = "사무실 챙길 것 — " + Object.entries(rows).map(([b, items]) => `${short(b)}: ${items.map(it => `${it.name}${it.qty ? " " + it.qty + it.unit : ""}`).join(", ")}`).join(" / ");
    extra = `<button type="button" class="ghost office">사무실 챙길 것 복사</button>`;
  }
  c.innerHTML = `<div class="card-head"><h3>${esc(v.label)}</h3></div>${note ? `<div class="note">${esc(note)}</div>` : ""}${parts}${extra}${v.app ? `<div class="actions">${appBtn(v.app)}</div>` : ""}`;
  const ob = c.querySelector(".office");
  if (ob) ob.onclick = () => copy(ob, c.dataset.txt);
  return c;
}

function urbanCard(v, rows) {
  const all = [...DATA.branches, ...v.extra_branches];
  const get = (b, n) => (rows[b] || []).filter(it => it.name === n).reduce((s, it) => s + it.qty, 0);
  const c = document.createElement("div");
  c.className = "card";
  c.innerHTML = `<div class="card-head"><h3>${esc(v.label)}</h3><span class="phone">카톡 · 대표님</span></div>
    <div class="extra"><span class="h">매장</span><span class="h">번 (박스)</span><span class="h">패티 (박스)</span>
    ${all.map(b => `<span>${short(b)}</span><input data-b="${b}" data-n="번" inputmode="decimal" value="${get(b, "번") || ""}"><input data-b="${b}" data-n="패티" inputmode="decimal" value="${get(b, "패티") || ""}">`).join("")}</div>
    <textarea aria-label="어반부처스 발주 메시지"></textarea>
    <button type="button" class="copy">복사 (카톡에 붙여넣기)</button>`;
  const ta = c.querySelector("textarea");
  const val = (b, n) => c.querySelector(`input[data-b="${b}"][data-n="${n}"]`).value.trim();
  const render = () => {
    ta.value = all.map(b => {
      const bun = val(b, "번"), pat = val(b, "패티");
      if (!bun && !pat) return null;
      return `${short(b)} : ` + [bun && `번 ${bun}박스`, pat && `패티 ${pat}박스`].filter(Boolean).join(" / ");
    }).filter(Boolean).join("\n");
  };
  c.querySelectorAll("input").forEach(i => i.addEventListener("input", render));
  render();
  c.querySelector(".copy").onclick = e => copy(e.currentTarget, ta.value);
  return c;
}

// 코카콜라: 전날 재고로 자동 계산한 문자 (매장별 담당자)
function cokeCards(v, send, alerts) {
  const k = DATA.coke;
  const fmt = n => (Math.round(n * 10) / 10).toString();
  for (const b of DATA.branches) {
    const x = k.branches[b];
    const staff = (DATA.table[v.key] || {})[b] || []; // 직원이 따로 적은 코카 발주(있으면 같이 표시)
    if (!x.rows.length) {
      alerts.push(`코카콜라 ${short(b)}: ${k.srcDay.slice(5).replace("-", "/")} 재고 기록이 없어 자동 계산 못 함`);
      continue;
    }
    if (x.missing.length) alerts.push(`코카콜라 ${short(b)}: 재고 미입력 ${x.missing.join(", ")}`);
    const order = x.rows.filter(r => r.qty > 0);
    const items = order.map(r => `${r.name} ${r.qty}${r.unit}`).concat(staff.map(line)).join("\n");
    const calc = `<div class="note">${k.orderLabel} 아침 발주 · ${+k.srcDay.slice(5, 7)}/${+k.srcDay.slice(8)} 직원 재고 기준</div>
      <div class="calc"><span class="h">품목</span><span class="h">재고</span><span class="h">소진 후</span><span class="h o">주문</span>
      ${x.rows.map(r => `<span>${esc(r.name)}</span><span>${fmt(r.stock)}</span><span>${fmt(r.est)}</span><span class="o">${r.qty ? r.qty : "-"}</span>`).join("")}</div>`;
    const text = order.length || staff.length ? (v.format ? v.format.replace("{branch}", short(b)).replace("{items}", items) : items) : "";
    const card = smsCard(`${v.label} ${short(b)}`, v.per_branch[b], text || "(이번엔 주문할 것 없음)", calc);
    send.appendChild(card);
  }
}

function stockSection(alerts) {
  const V = Object.fromEntries(DATA.vendors.map(v => [v.key, v]));
  const keys = Object.keys(DATA.stock || {});
  if (!keys.length) return null;
  const st = document.createElement("section");
  st.innerHTML = `<h2>필수 품목 재고 (직원 기록)</h2>` + keys.map(k => {
    const byBr = DATA.stock[k];
    const brs = DATA.branches.filter(b => byBr[b]).concat(Object.keys(byBr).filter(b => !DATA.branches.includes(b)));
    const names = [...new Set(brs.flatMap(b => byBr[b].map(it => it.name)))];
    const cell = (b, n) => {
      const it = (byBr[b] || []).find(x => x.name === n);
      if (!it || it.stock == null) return `<td class="na">-</td>`;
      if (it.stock === 0) alerts.push(`${short(b)} ${n} 재고 0`);
      return `<td class="${it.stock === 0 ? "zero" : ""}">${it.stock}</td>`;
    };
    return `<div class="card"><div class="card-head"><h3>${esc(V[k].label)}</h3></div><table class="stock">
      <tr><th>품목</th>${brs.map(b => `<th>${esc(short(b))}</th>`).join("")}</tr>
      ${names.map(n => `<tr><td>${esc(n)}${DATA.stockLinks[n] ? `<a href="${esc(DATA.stockLinks[n])}" target="_blank" rel="noopener">쿠팡</a>` : ""}</td>${brs.map(b => cell(b, n)).join("")}</tr>`).join("")}
      </table>${V[k].app ? `<div class="actions">${appBtn(V[k].app)}</div>` : ""}</div>`;
  }).join("");
  return st;
}

function render() {
  const fetched = new Date(DATA.fetched_at).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const chips = DATA.branches.map(b => DATA.submitted[b]
    ? `<span class="chip ${tagClass(b)}">${short(b)} ${DATA.submitted[b]}차 · ${DATA.times[b].join(", ")}</span>`
    : `<span class="chip off">${short(b)} 미제출</span>`).join("");
  app.innerHTML = `<header><div class="topbar"><button type="button" class="ghost" id="prev" aria-label="전날">◀</button><h1>${DATA.label} 발주</h1><button type="button" class="ghost" id="next" aria-label="다음날">▶</button></div>
    <div class="status">${chips}</div>
    <div class="toolbar"><button type="button" class="ghost" id="reload">새로고침</button>${DAY !== kstToday() ? `<button type="button" class="ghost" id="today">오늘로</button>` : ""}</div>
    <div class="fetched">발주앱 기준 ${fetched} 불러옴</div></header>`;
  app.querySelector("#prev").onclick = () => go(shiftDay(DAY, -1));
  app.querySelector("#next").onclick = () => go(shiftDay(DAY, 1));
  app.querySelector("#reload").onclick = () => go(DAY);
  const t = app.querySelector("#today"); if (t) t.onclick = () => go(kstToday());

  const alerts = [];
  for (const [, rows] of Object.entries(DATA.table)) for (const [b, items] of Object.entries(rows)) for (const it of items) if (it.warn) alerts.push(`${short(b)} ${it.name}: ${it.warn}`);
  for (const [b, items] of Object.entries(DATA.table["인터넷발주"] || {})) items.forEach(it => { if (it.stockOnly && it.stock === 0) alerts.push(`${short(b)} ${it.name} 재고 0`); });
  for (const [b, items] of Object.entries(DATA.table["확인필요"] || {})) items.forEach(it => alerts.push(`${short(b)} ${it.name}: 거래처 미지정`));
  const alertBox = document.createElement("div");
  app.appendChild(alertBox);

  const send = document.createElement("section");
  send.innerHTML = "<h2>보낼 문자</h2>";
  const empty = [];
  for (const v of DATA.vendors) {
    const rows = DATA.table[v.key] || {};
    const has = Object.keys(rows).length > 0;
    if (v.kind === "sms") {
      if (v.key === "코카콜라" && DATA.coke) cokeCards(v, send, alerts);
      else if (v.per_branch) {
        DATA.branches.forEach(b => rows[b]
          ? send.appendChild(smsCard(`${v.label} ${short(b)}`, v.per_branch[b], smsMessage(rows, [b], b, v.format)))
          : empty.push(`${v.label} ${short(b)}`));
      } else if (has) send.appendChild(smsCard(v.label, v.phone, smsMessage(rows, DATA.branches, null, v.format, v.inline)));
      else empty.push(v.label);
    } else if (v.kind === "kakao") {
      if (has) send.appendChild(urbanCard(v, rows)); else empty.push(v.label);
    }
  }
  if (empty.length) send.insertAdjacentHTML("beforeend", `<div class="none">오늘 없음 · ${empty.join(", ")}</div>`);
  app.appendChild(send);

  const self = document.createElement("section");
  self.innerHTML = "<h2>직접 주문</h2>";
  const selfEmpty = [];
  for (const v of DATA.vendors) {
    if (["sms", "kakao"].includes(v.kind)) continue;
    const rows = DATA.table[v.key] || {};
    if (Object.keys(rows).length) self.appendChild(listCard(v, rows, v.kind === "unknown"));
    else if (v.kind !== "unknown") selfEmpty.push(v.label);
  }
  if (selfEmpty.length) self.insertAdjacentHTML("beforeend", `<div class="none">오늘 없음 · ${selfEmpty.join(", ")}</div>`);
  app.appendChild(self);

  const st = stockSection(alerts);
  if (st) app.appendChild(st);
  if (DATA.memos.length) {
    const m = document.createElement("section");
    m.innerHTML = `<h2>직원 메모</h2>` + DATA.memos.map(x => `<div class="card">${storeTag(x.branch)}<div>${esc(x.memo)}</div><div class="note">${x.seq}차 발주</div></div>`).join("");
    app.appendChild(m);
  }
  if (alerts.length) alertBox.outerHTML = `<div class="alerts"><b>확인할 것 ${alerts.length}</b><ul>${alerts.map(a => `<li>${esc(a)}</li>`).join("")}</ul></div>`;
  else alertBox.remove();

  const foot = document.createElement("section");
  foot.innerHTML = `<button type="button" class="ghost" id="logout">로그아웃</button>`;
  foot.querySelector("#logout").onclick = async () => { await sb.auth.signOut(); showLogin(); };
  app.appendChild(foot);
  app.querySelectorAll(".links a").forEach(a => a.addEventListener("click", () => { store.set(a.dataset.k, true); a.classList.add("visited"); }));
}

async function go(day) {
  DAY = day;
  history.replaceState(null, "", "#" + day);
  app.innerHTML = `<div class="loading">${day} 발주 불러오는 중…</div>`;
  try {
    const isOrderDay = (CFG.coke_plan?.order_weekdays || []).includes(weekday(day)); // 월·목은 전날 재고로 코카 계산
    const [raw, prevRaw] = await Promise.all([fetchOrders(sb, day), isOrderDay ? fetchOrders(sb, addDays(day, -1)) : null]);
    DATA = buildData(day, raw, CFG, CMAP, prevRaw);
    render();
  } catch (e) {
    app.innerHTML = `<div class="card"><div class="err">불러오기 실패: ${esc(e.message)}</div><button type="button" id="retry">다시 시도</button></div>`;
    app.querySelector("#retry").onclick = () => go(day);
  }
}

async function start() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return showLogin();
  try { await loadConfig(session.user.id); }
  catch (e) { return showLogin("이 계정으로는 거래처 설정을 열 수 없습니다. 사장님 계정으로 로그인하세요."); }
  go(DAY);
}

// 홈 화면 앱으로 다시 열 때(백그라운드 복귀) 최신 발주로 갱신
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && DATA && DAY === kstToday() && Date.now() - new Date(DATA.fetched_at) > 10 * 60e3) go(DAY); });
start();
