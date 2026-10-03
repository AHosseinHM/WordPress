/*
  ==================================================================
  واردکننده گروهی محصولات ووکامرس — app.js
  ------------------------------------------------------------------
  راهنمای سریع:
  1) آدرس فروشگاه، کلید و رمز REST را وارد و «تست اتصال» را بزنید.
  2) فایل CSV بارگذاری کنید یا محصولات را دستی وارد کنید.
  3) لیست پیش‌نمایش را بررسی و «شروع واردسازی» را بزنید.
  محصولات به‌صورت دسته‌ای (batch) با الگوی WooCommerce REST v3
  (POST /wp-json/wc/v3/products/batch) ارسال می‌شوند.
  ==================================================================
*/
"use strict";

/* ---------------- تنظیمات عمومی ---------------- */
const DELAY_BETWEEN_BATCHES = 500; // میلی‌ثانیه تأخیر بین دسته‌ها

/* ---------------- وضعیت سراسری ---------------- */
const state = {
  store: null,      // { url, key, secret }
  products: [],     // آرایه محصولات آماده ارسال
  mode: "csv",
  importing: false,
};

/* ---------------- ابزارها ---------------- */
const $ = (id) => document.getElementById(id);
const fa = (n) => String(n).replace(/\d/g, d => "۰۱۲۳۴۵۶۷۸۹"[d]);
const logBox = $("log");

function log(msg, type = "info") {
  const time = new Date().toLocaleTimeString("fa-IR");
  const line = `[${time}] ${msg}`;
  const cls = type === "error" ? "log-err" : type === "ok" ? "log-ok" : "";
  logBox.innerHTML += (logBox.innerHTML ? "\n" : "") + `<span class="${cls}">${line}</span>`;
  logBox.scrollTop = logBox.scrollHeight;
  console.log(line);
}

/* تبدیل مقادیر CSV به عدد امن */
function num(v) {
  if (v === undefined || v === null || v === "") return undefined;
  const n = parseFloat(String(v).replace(/[^\d.\-]/g, ""));
  return isNaN(n) ? undefined : n;
}

/* تبدیل یک ردیف خام به آبجکت استاندارد محصول ووکامرس */
function normalizeRow(row) {
  const name = (row.name || row["نام"] || "").trim();
  if (!name) return null;

  const p = {
    name,
    type: "simple",
    status: row.status ? row.status.trim() : "publish",
    regular_price: num(row.regular_price || row.price || row["قیمت"]),
    description: (row.description || "").trim(),
    short_description: (row.short_description || "").trim(),
    sku: (row.sku || "").trim() || undefined,
  };

  const sale = num(row.sale_price || row["فروش ویژه"]);
  if (sale !== undefined) p.sale_price = String(sale);
  if (p.regular_price !== undefined) p.regular_price = String(p.regular_price);

  /* دسته‌بندی‌ها: با کاما جدا، ووکامرس با نام می‌سازد */
  const cats = (row.category || row["دسته"] || "").split(",").map(s => s.trim()).filter(Boolean);
  if (cats.length) p.categories = cats.map(c => ({ name: c }));

  /* تگ‌ها */
  const tags = (row.tags || "").split(",").map(s => s.trim()).filter(Boolean);
  if (tags.length) p.tags = tags.map(t => ({ name: t }));

  /* موجودی */
  const stock = num(row.stock);
  if (stock !== undefined) {
    p.manage_stock = true;
    p.stock_quantity = stock;
  }
  const ss = (row.stock_status || "").trim();
  if (["instock", "outofstock", "onbackorder"].includes(ss)) p.stock_status = ss;

  const w = num(row.weight);
  if (w !== undefined) p.weight = String(w);

  const img = (row.image_url || row.image || "").trim();
  if (img) p.images = [{ src: img }];

  return p;
}

/* ---------------- پارسر CSV سبک (پشتیبانی از کوتیشن و BOM) ---------------- */
function parseCSV(text) {
  text = text.replace(/^\uFEFF/, ""); // حذف BOM
  const rows = [];
  let row = [], field = "", inQ = false;
  const delim = (text.split("\n")[0].match(/;/g) || []).length >
                (text.split("\n")[0].match(/,/g) || []).length ? ";" : ",";

  for (let i = 0; i < text.length; i++) {
    const c = text[i], nxt = text[i + 1];
    if (inQ) {
      if (c === '"' && nxt === '"') { field += '"'; i++; }
      else if (c === '"') inQ = false;
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === delim) { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c === "\r") { /* رد شود */ }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  if (rows.length < 2) return [];
  const headers = rows[0].map(h => h.trim());
  return rows.slice(1).filter(r => r.some(v => v.trim() !== ""))
    .map(r => Object.fromEntries(headers.map((h, i) => [h, (r[i] || "").trim()])));
}

/* ---------------- اتصال به ووکامرس (Basic Auth) ---------------- */
function apiEndpoint(path) {
  const url = state.store.url.replace(/\/+$/, "");
  return `${url}/wp-json/wc/v3/${path}`;
}

async function wcRequest(path, options = {}) {
  const auth = btoa(`${state.store.key}:${state.store.secret}`);
  const res = await fetch(apiEndpoint(path), {
    ...options,
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    let detail = "";
    try { const j = await res.json(); detail = j.message || JSON.stringify(j); } catch { detail = res.statusText; }
    throw new Error(`HTTP ${res.status}: ${detail}`);
  }
  return res.json();
}

async function testConnection(e) {
  e.preventDefault();
  const url = $("storeUrl").value.trim();
  const key = $("consumerKey").value.trim();
  const secret = $("consumerSecret").value.trim();
  if (!url || !key || !secret) return;
  if (new URL(url).protocol !== "https:") { log("برای حفاظت از کلیدهای API، آدرس فروشگاه باید HTTPS باشد.", "error"); setConnUI("err"); return; }

  state.store = { url, key, secret };
  setConnUI("loading");
  log(`در حال تست اتصال به ${url} ...`);
  try {
    // سیستم بسته؟ سپس شمارش محصولات برای اطمینان از دسترسی
    await wcRequest("system_status", { method: "GET" }).catch(() => {});
    const products = await wcRequest("products?per_page=1&page=1", { method: "GET" });
    setConnUI("ok");
    log(`اتصال موفق بود ✓ (نمونه محصول دریافت شد: ${products.length ? "بله" : "فروشگاه خالی"})`, "ok");
    if (!state.importing) $("btnImport").disabled = state.products.length === 0;
  } catch (err) {
    setConnUI("err");
    log(`خطای اتصال: ${err.message}`, "error");
  }
}

function setConnUI(status) {
  const dot = $("connStatus"), badge = $("connBadge");
  dot.className = "status-dot " + status;
  const map = {
    ok:    ["badge-on", "اتصال برقرار", "متصل"],
    err:   ["badge-err", "اتصال ناموفق", "قطع"],
    off:   ["badge-off", "متصل نیست", "متصل نیست"],
    loading:["badge-load", "در حال بررسی…", "در حال بررسی"],
  };
  const [cls, text, short] = map[status];
  badge.className = "badge " + cls;
  badge.textContent = short;
  dot.title = text;
}

/* ---------------- پیش‌نمایش ---------------- */
function renderPreview() {
  const tb = $("previewBody");
  $("previewCount").textContent = fa(state.products.length);
  $("statTotal").textContent = fa(state.products.length);
  if (!state.products.length) {
    tb.innerHTML = `<tr class="empty-row"><td colspan="9">هنوز محصولی اضافه نشده — از بالا CSV بارگذاری کنید یا دستی وارد کنید.</td></tr>`;
    return;
  }
  tb.innerHTML = state.products.map((p, i) => `
    <tr>
      <td>${fa(i + 1)}</td>
      <td class="cell-name" title="${esc(p.description).slice(0,200)}">${esc(p.name)}</td>
      <td>${esc(p.sku || "—")}</td>
      <td>${p.regular_price ?? "—"}</td>
      <td>${p.sale_price ?? "—"}</td>
      <td>${(p.categories || []).map(c => esc(c.name)).join("، ") || "—"}</td>
      <td>${p.stock_quantity ?? "—"}</td>
      <td>${p.images ? "🖼" : "—"}</td>
      <td><button class="del" data-i="${i}" title="حذف">✕</button></td>
    </tr>`).join("");
  $("btnImport").disabled = !state.importing && state.products.length === 0;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function addProducts(list) {
  const valid = list.filter(p => p && p.name);
  state.products = state.products.concat(valid);
  log(`${fa(valid.length)} محصول به لیست پیش‌نمایش اضافه شد.`);
  renderPreview();
}

/* ---------------- بارگذاری CSV ---------------- */
function handleCSV(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const rows = parseCSV(reader.result);
      if (!rows.length) throw new Error("فایل خالی یا نامعتبر است (ستون name الزامی است).");
      const prods = rows.map(normalizeRow).filter(Boolean);
      if (!prods.length) throw new Error("هیچ ردیفی با ستون name معتبر پیدا نشد.");
      addProducts(prods);
    } catch (err) {
      log(`خطای CSV: ${err.message}`, "error");
    }
  };
  reader.readAsText(file, "UTF-8");
}

/* ---------------- ورود دستی ---------------- */
function addManual() {
  const name = $("mName").value.trim();
  if (!name) { log("نام محصول الزامی است.", "error"); return; }
  const p = normalizeRow({
    name,
    regular_price: $("mPrice").value,
    sale_price: $("mSale").value,
    sku: $("mSku").value,
    category: $("mCat").value,
    tags: $("mTags").value,
    stock: $("mStock").value,
    weight: $("mWeight").value,
    image_url: $("mImage").value,
    short_description: $("mShort").value,
    description: $("mDesc").value,
  });
  addProducts([p]);
  ["mName", "mPrice", "mSale", "mSku", "mCat", "mTags", "mStock", "mWeight", "mImage", "mShort", "mDesc"]
    .forEach(id => { if (!$("mRepeat").checked) $(id).value = ""; });
  $("mName").focus();
}

/* ---------------- ورود گروهی با دسته‌بندی ---------------- */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runImport() {
  if (state.importing || !state.products.length) return;
  if (!state.store) { log("ابتدا به فروشگاه متصل شوید.", "error"); return; }
  state.importing = true;
  $("btnImport").disabled = true;
  $("btnImport").textContent = "در حال واردسازی…";

  const size = Math.min(100, Math.max(1, parseInt($("batchSize").value) || 5));
  const batches = [];
  for (let i = 0; i < state.products.length; i += size) batches.push(state.products.slice(i, i + size));

  let ok = 0, fail = 0;
  const publish = $("publishMode").checked;
  const total = state.products.length;

  for (let b = 0; b < batches.length; b++) {
    const payload = { create: batches[b].map(p => ({ ...p, status: publish ? "publish" : "draft" })) };
    log(`ارسال دسته ${fa(b + 1)} از ${fa(batches.length)} (${fa(payload.create.length)} محصول)…`);
    try {
      const res = await wcRequest("products/batch", { method: "POST", body: JSON.stringify(payload) });
      ok += (res.create || []).filter(r => r.id || r.status !== "error").length;
      fail += (res.create || []).filter(r => r.error).length;
      (res.create || []).forEach(r => {
        if (r.error) log(`خطا در «${r.name}»: ${r.error.message}`, "error");
      });
    } catch (err) {
      fail += payload.create.length;
      log(`خطای دسته ${b + 1}: ${err.message}`, "error");
    }
    /* به‌روزرسانی پیشرفت و آمار */
    const done = Math.min(total, (b + 1) * size);
    const pct = Math.round((done / total) * 100);
    $("progressFill").style.width = pct + "%";
    $("progressPct").textContent = fa(pct) + "٪";
    $("progressText").textContent = `دسته ${fa(b + 1)} از ${fa(batches.length)}`;
    $("statOk").textContent = fa(ok);
    $("statErr").textContent = fa(fail);
    if (b < batches.length - 1) await sleep(DELAY_BETWEEN_BATCHES);
  }

  log(`پایان واردسازی ✓ موفق: ${fa(ok)} — ناموفق: ${fa(fail)}`, fail ? "info" : "ok");
  state.importing = false;
  $("btnImport").textContent = "شروع واردسازی";
  $("progressText").textContent = "تمام شد";
  /* حذف موفق‌ها از لیست: برای سادگی، در صورت نبود خطا لیست خالی می‌شود */
  if (fail === 0) { state.products = []; renderPreview(); }
  else { $("btnImport").disabled = false; }
}

/* ---------------- نمونه CSV ---------------- */
function downloadSample() {
  const sample = `name,sku,regular_price,sale_price,category,stock,stock_status,weight,image_url,short_description,description,tags
تی‌شرت مردانه,مردانه-01,250000,199000,"پوشاک، تی‌شرت",10,instock,0.3,https://example.com/img1.jpg,تی‌شرت پنبه‌ای,توضیحات کامل محصول,تابستان
کتانی ورزشی,کتانی-02,1250000,990000,"کفش",5,instock,0.9,,کفش سبک ورزشی,توضیحات کامل,ورزشی`;
  const blob = new Blob(["\uFEFF" + sample], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "sample-products.csv";
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------------- رویدادها ---------------- */
$("connForm").addEventListener("submit", testConnection);

/* تب‌های حالت ورود */
document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".pane").forEach(p => p.classList.remove("active"));
    tab.classList.add("active");
    $("paneCsv").classList.toggle("active", tab.dataset.mode === "csv");
    $("paneManual").classList.toggle("active", tab.dataset.mode === "manual");
  });
});

/* درگ‌ودراپ؛ input درون label است و کلیک بومی را دریافت می‌کند */
const dz = $("dropzone");
$("csvFile").addEventListener("change", e => e.target.files[0] && handleCSV(e.target.files[0]));
dz.addEventListener("dragover", e => { e.preventDefault(); dz.classList.add("drag"); });
dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
dz.addEventListener("drop", e => {
  e.preventDefault(); dz.classList.remove("drag");
  if (e.dataTransfer.files[0]) handleCSV(e.dataTransfer.files[0]);
});

$("btnSampleCsv").addEventListener("click", downloadSample);
$("btnAddManual").addEventListener("click", addManual);
$("btnImport").addEventListener("click", runImport);
$("btnClear").addEventListener("click", () => { state.products = []; renderPreview(); $("progressFill").style.width = "0"; $("progressText").textContent = "آماده"; $("progressPct").textContent = "۰٪"; });
$("previewBody").addEventListener("click", e => {
  if (e.target.classList.contains("del")) {
    state.products.splice(+e.target.dataset.i, 1);
    renderPreview();
  }
});

/* هیچ کلید API در localStorage یا کوکی ذخیره نمی‌شود. */
window.addEventListener("DOMContentLoaded", () => {
  renderPreview();
  setConnUI("off");
});
