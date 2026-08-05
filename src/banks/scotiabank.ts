import type { Page } from "puppeteer-core";
import type { BankMovement, BankScraper, ScrapeResult, ScraperOptions } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { closePopups, delay, parseChileanAmount, normalizeDate, deduplicateMovements } from "../utils.js";
import { runScraper } from "../infrastructure/scraper-runner.js";
import type { BrowserSession } from "../infrastructure/browser.js";
import { fillRut, fillPassword, clickSubmit, detectLoginError } from "../actions/login.js";
import { dismissBanners } from "../actions/navigation.js";
import { detect2FA, waitFor2FA } from "../actions/two-factor.js";

// ─── Scotiabank-specific constants ───────────────────────────────

const BANK_URL = "https://www.scotiabank.cl";
const EMPRESA_LOGIN_URL = "https://appservtrx.scotiabank.cl/portalempresas/login";

const LOGIN_SELECTORS = {
  rutSelectors: ["#inputDni", 'input[name="inputDni"]', 'input[id*="Dni"]', 'input[name*="Dni"]'],
  passwordSelectors: ["#inputPassword", 'input[name="inputPassword"]', 'input[id*="Password"]', 'input[name*="Password"]'],
  rutFormat: "dash" as const,
};

const EMPRESA_2FA_CONFIG = {
  timeoutEnvVar: "SCOTIABANK_2FA_TIMEOUT_SEC",
  defaultTimeoutSec: 180,
  keywords: [
    "clave dinámica",
    "clave dinamica",
    "scotiapass",
    "segundo factor",
    "aprueba la operación",
    "autoriza en",
    "desafío",
    "desafio",
  ],
};

function formatRutDash(rut: string): string {
  const clean = rut.replace(/[^0-9kK]/g, "").toUpperCase();
  if (clean.length < 2) return clean;
  return `${clean.slice(0, -1)}-${clean.slice(-1)}`;
}

// ─── Shadow DOM helper ───────────────────────────────────────────

function allDeepJs(): string {
  return `function allDeep(root, sel) {
    const out = Array.from(root.querySelectorAll(sel));
    for (const el of Array.from(root.querySelectorAll("*"))) {
      if (el.shadowRoot) out.push(...allDeep(el.shadowRoot, sel));
    }
    return out;
  }`;
}

// ─── Scotiabank-specific helpers ─────────────────────────────────

async function waitForDashboardContent(page: Page): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 15000) {
    const hasContent = await page.evaluate(new Function(`${allDeepJs()}
      return allDeep(document, "a, button, span").some(el => {
        const text = el.innerText?.trim().toLowerCase() || "";
        return text === "ver cartola" || text === "cuenta corriente";
      });`) as () => boolean);
    if (hasContent) break;
    await delay(1500);
  }
}

async function dismissScotiaTutorial(page: Page, debugLog: string[]): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const dismissed = await page.evaluate(new Function(`${allDeepJs()}
      for (const el of allDeep(document, "button, a, span")) {
        const text = el.innerText?.trim().toLowerCase() || "";
        if (text === "continuar" || text === "terminar" || text === "cerrar" || text === "omitir" || text === "saltar") {
          el.click(); return text;
        }
      }
      return null;`) as () => string | null);
    if (!dismissed) break;
    debugLog.push(`  Tutorial dismissed: "${dismissed}"`);
    await delay(600);
  }
}

async function navigateToMovements(page: Page, debugLog: string[]): Promise<void> {
  await waitForDashboardContent(page);

  // Try "Ver cartola" (pierce Shadow DOM)
  const clickedCartola = await page.evaluate(new Function(`${allDeepJs()}
    for (const el of allDeep(document, "a, button, span")) {
      const text = el.innerText?.trim().toLowerCase() || "";
      if (text === "ver cartola" || text === "ver saldo y movimientos") {
        el.click(); return true;
      }
    }
    return false;`) as () => boolean);
  if (clickedCartola) { debugLog.push("  Clicked: Ver cartola"); await delay(5000); return; }

  // Sidebar fallback
  const clickedCuentas = await page.evaluate(new Function(`${allDeepJs()}
    for (const el of allDeep(document, "a, button, li, span")) {
      if (el.innerText?.trim().toLowerCase() === "cuentas") { el.click(); return true; }
    }
    return false;`) as () => boolean);
  if (clickedCuentas) { debugLog.push("  Sidebar: Cuentas"); await delay(2500); }

  // Try clicking "Saldos y últimos movimientos" tab first (NOT "Cartolas" which shows PDFs)
  const clickedSaldos = await page.evaluate(new Function(`${allDeepJs()}
    for (const el of allDeep(document, "a, button, [role='tab'], li, span")) {
      const text = el.innerText?.trim().toLowerCase() || "";
      if (text.includes("saldos y") || text.includes("últimos movimientos") || text === "saldos") {
        el.click(); return true;
      }
    }
    return false;`) as () => boolean);
  if (clickedSaldos) { debugLog.push("  Clicked: Saldos y últimos movimientos tab"); await delay(5000); return; }

  const subTargets = ["movimientos", "estado de cuenta", "ver movimientos"];
  for (const target of subTargets) {
    const clicked = await page.evaluate(new Function(`${allDeepJs()}
      var target = ${JSON.stringify(target)};
      for (const el of allDeep(document, "a, button, [role='menuitem'], li, span")) {
        const text = el.innerText?.trim().toLowerCase() || "";
        if (text.includes(target) && text.length < 60) { el.click(); return true; }
      }
      return false;`) as () => boolean);
    if (clicked) { debugLog.push(`  Clicked: ${target}`); await delay(5000); return; }
  }
}

async function extractMovements(page: Page): Promise<BankMovement[]> {
  // Extract from page + all frames (piercing Shadow DOM)
  const contexts: Array<{ evaluate: Page["evaluate"] }> = [page];
  for (const frame of page.frames()) {
    if (frame !== page.mainFrame()) contexts.push(frame as unknown as { evaluate: Page["evaluate"] });
  }

  const allRaw: Array<{ date: string; description: string; amount: string; balance: string }> = [];
  for (const ctx of contexts) {
    try {
      const raw = await ctx.evaluate(new Function(`${allDeepJs()}
        const results = [];
        const tables = allDeep(document, "table");
        for (const table of tables) {
          const rows = Array.from(table.querySelectorAll("tr"));
          if (rows.length < 2) continue;
          let dateIndex = 0, descriptionIndex = 1, cargoIndex = -1, abonoIndex = -1, amountIndex = -1, balanceIndex = -1, hasHeader = false;
          for (const row of rows) {
            const headers = row.querySelectorAll("th");
            if (headers.length < 2) continue;
            const ht = Array.from(headers).map(h => h.innerText?.trim().toLowerCase() || "");
            if (!ht.some(h => h.includes("fecha"))) continue;
            hasHeader = true;
            dateIndex = ht.findIndex(h => h.includes("fecha"));
            descriptionIndex = ht.findIndex(h => h.includes("descrip") || h.includes("detalle") || h.includes("glosa"));
            cargoIndex = ht.findIndex(h => h.includes("cargo") || h.includes("débito") || h.includes("debito"));
            abonoIndex = ht.findIndex(h => h.includes("abono") || h.includes("crédito") || h.includes("credito"));
            amountIndex = ht.findIndex(h => h === "monto" || h.includes("importe"));
            balanceIndex = ht.findIndex(h => h.includes("saldo"));
            break;
          }
          if (!hasHeader) continue;
          let lastDate = "";
          for (const row of rows) {
            const cells = row.querySelectorAll("td");
            if (cells.length < 3) continue;
            const values = Array.from(cells).map(c => c.innerText?.trim() || "");
            const rawDate = values[dateIndex] || "";
            const hasDate = /^\\d{1,2}[\\/.-]\\d{1,2}([\\/.-]\\d{2,4})?$/.test(rawDate);
            const date = hasDate ? rawDate : lastDate;
            if (!date) continue;
            if (hasDate) lastDate = rawDate;
            const description = descriptionIndex >= 0 ? (values[descriptionIndex] || "") : "";
            let amount = "";
            if (cargoIndex >= 0 && values[cargoIndex]) amount = "-" + values[cargoIndex];
            else if (abonoIndex >= 0 && values[abonoIndex]) amount = values[abonoIndex];
            else if (amountIndex >= 0) amount = values[amountIndex] || "";
            const balance = balanceIndex >= 0 ? (values[balanceIndex] || "") : "";
            if (!amount) continue;
            results.push({ date, description, amount, balance });
          }
        }
        if (results.length === 0) {
          const cards = allDeep(document, "[class*='mov'], [class*='tran'], [class*='transaction'], li, article");
          for (const card of cards) {
            const text = card.innerText || "";
            const lines = text.split("\\n").map(l => l.trim()).filter(Boolean);
            if (lines.length < 3 || lines.length > 10) continue;
            const date = lines.find(l => /\\d{1,2}[\\/.-]\\d{1,2}[\\/.-]\\d{2,4}/.test(l));
            const amount = lines.find(l => /[$]\\s*[\\d.]+/.test(l));
            if (!date || !amount) continue;
            const description = lines.find(l => l !== date && l !== amount && l.length > 3) || "";
            const balance = lines.find(l => l.toLowerCase().includes("saldo") && /[$]\\s*[\\d.]+/.test(l)) || "";
            const isCargo = text.toLowerCase().includes("cargo") || text.toLowerCase().includes("débito") || amount.includes("-");
            results.push({ date, description, amount: isCargo ? (amount.startsWith("-") ? amount : "-" + amount) : amount, balance });
          }
        }
        return results;`) as () => Array<{ date: string; description: string; amount: string; balance: string }>);
      allRaw.push(...raw);
    } catch { /* detached frame */ }
  }

  const seen = new Set<string>();
  return allRaw.map(m => {
    const amount = parseChileanAmount(m.amount);
    if (amount === 0) return null;
    return { date: normalizeDate(m.date), description: m.description, amount, balance: m.balance ? parseChileanAmount(m.balance) : 0, source: MOVEMENT_SOURCE.account } as BankMovement;
  }).filter((m): m is BankMovement => {
    if (!m) return false;
    const key = `${m.date}|${m.description}|${m.amount}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function scotiaPaginate(page: Page, debugLog: string[]): Promise<BankMovement[]> {
  const all: BankMovement[] = [];
  for (let i = 0; i < 20; i++) {
    all.push(...await extractMovements(page));
    const urlBefore = page.url();
    const nextClicked = await page.evaluate(new Function(`${allDeepJs()}
      const candidates = allDeep(document, "button, a, [role='button']");
      for (const btn of candidates) {
        const text = btn.innerText?.trim().toLowerCase() || "";
        if (!text.includes("siguiente") && !text.includes("ver más") && !text.includes("mostrar más") && text !== "›" && text !== ">") continue;
        if (btn.disabled || btn.getAttribute("aria-disabled") === "true" || btn.classList.contains("disabled")) return false;
        btn.click(); return true;
      }
      return false;`) as () => boolean);
    if (!nextClicked) break;
    await delay(3000);
    const urlAfter = page.url();
    if (new URL(urlBefore).pathname.split("/").slice(0, 6).join("/") !== new URL(urlAfter).pathname.split("/").slice(0, 6).join("/")) { debugLog.push("  Pagination stopped: URL changed"); break; }
    debugLog.push(`  Pagination: page ${i + 2}`);
  }
  return deduplicateMovements(all);
}

async function navigateToPreviousPeriod(page: Page, debugLog: string[], doSave: (page: Page, name: string) => Promise<void>, stepIndex: number): Promise<boolean> {
  // Expand sidebar Cuentas
  await page.evaluate(new Function(`${allDeepJs()}
    for (const el of allDeep(document, "nav a, nav button, aside a, aside button, a, button, li, span")) {
      if (el.innerText?.trim().toLowerCase() === "cuentas") { el.click(); return true; }
    }
    return false;`) as () => boolean);
  await delay(2000);

  // Click Cartola/Movimientos submenu
  const subTargets = ["cartola", "movimientos cuenta", "cuenta corriente", "movimientos"];
  let entered = false;
  for (const target of subTargets) {
    const clicked = await page.evaluate(new Function(`${allDeepJs()}
      var t = ${JSON.stringify(target)};
      for (const el of allDeep(document, "a, button, [role='menuitem'], li, span")) {
        const text = el.innerText?.trim().toLowerCase() || "";
        if (text.includes(t) && text.length < 80) { el.click(); return true; }
      }
      return false;`) as () => boolean);
    if (clicked) { debugLog.push(`  Sidebar: ${target}`); await delay(5000); entered = true; break; }
  }
  if (!entered) return false;

  // Click "Consultar Movimientos Anteriores"
  const targets = ["movimientos anteriores", "consultar movimientos", "consultar cartolas"];
  let clicked = false;
  // Try main page
  clicked = await page.evaluate(new Function(`${allDeepJs()}
    var tgts = ${JSON.stringify(targets)};
    for (const t of tgts) {
      for (const el of allDeep(document, "a, button, span, [role='tab'], [role='link'], li")) {
        const text = el.innerText?.trim().toLowerCase() || "";
        if (text.includes(t) && text.length < 80) { el.click(); return true; }
      }
    }
    return false;`) as () => boolean);

  // Try frames
  if (!clicked) {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      try {
        clicked = await frame.evaluate(new Function(`${allDeepJs()}
          var tgts = ${JSON.stringify(targets)};
          for (const t of tgts) {
            for (const el of allDeep(document, "a, button, span, [role='tab'], [role='link'], li")) {
              const text = el.innerText?.trim().toLowerCase() || "";
              if (text.includes(t) && text.length < 80) { el.click(); return true; }
            }
          }
          return false;`) as () => boolean);
        if (clicked) break;
      } catch { /* detached */ }
    }
  }

  if (!clicked) { debugLog.push("  No 'Consultar Movimientos Anteriores' link found"); return false; }
  debugLog.push("  Clicked: Consultar Movimientos Anteriores");
  await delay(4000);
  await doSave(page, `period-${stepIndex}-form`);
  return true;
}

async function fillAndSubmitDateRange(page: Page, startDate: string, endDate: string, debugLog: string[]): Promise<boolean> {
  const [sd, sm, sy] = startDate.split("/");
  const [ed, em, ey] = endDate.split("/");
  const frames = [page.mainFrame(), ...page.frames().filter((f) => f !== page.mainFrame())];

  for (const frame of frames) {
    try {
      const inputCount = await frame.evaluate(() =>
        Array.from(document.querySelectorAll('input[type="text"], input:not([type])')).filter(el => (el as HTMLInputElement).offsetParent !== null && !(el as HTMLInputElement).disabled).length
      ).catch(() => 0);
      if (inputCount < 4) continue;

      const filled = await frame.evaluate((vals: Record<string, string>) => {
        function setVal(el: HTMLInputElement, val: string) { el.focus(); el.value = val; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); el.blur(); }
        const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])')).filter(el => (el as HTMLInputElement).offsetParent !== null && !(el as HTMLInputElement).disabled) as HTMLInputElement[];
        let filled = 0;
        for (const inp of inputs) { const key = inp.name || inp.id; if (key && key in vals) { setVal(inp, vals[key]); filled++; } }
        if (filled === 0 && inputs.length >= 6) { const order = ["sd", "sm", "sy", "ed", "em", "ey"]; for (let i = 0; i < 6; i++) setVal(inputs[i], vals[order[i]]); return true; }
        return filled > 0;
      }, { idd: sd, imm: sm, iaa: sy, fdd: ed, fmm: em, faa: ey, sd, sm, sy, ed, em, ey });
      if (!filled) continue;

      await delay(500);
      const submitted = await frame.evaluate(() => {
        for (const el of document.querySelectorAll('button, input[type="submit"], input[type="button"], input[type="image"], a[href="#"]')) {
          const text = ((el as HTMLElement).innerText?.trim() || (el as HTMLInputElement).value || (el as HTMLInputElement).alt || "").toLowerCase();
          if (text === "aceptar" || text === "buscar" || text === "consultar" || text === "enviar") { (el as HTMLElement).click(); return true; }
        }
        for (const el of document.querySelectorAll('button, input[type="submit"], input[type="image"]')) {
          if ((el as HTMLInputElement).type === "submit" || (el as HTMLInputElement).type === "image") { (el as HTMLElement).click(); return true; }
        }
        return false;
      });
      if (submitted) { debugLog.push(`  Submitted: ${startDate} → ${endDate}`); await delay(6000); return true; }
    } catch { /* detached */ }
  }
  return false;
}

// ─── Main scrape function ────────────────────────────────────────

async function scrapeScotiabank(session: BrowserSession, options: ScraperOptions): Promise<ScrapeResult> {
  const scope = options.scope ?? (options.empresa ? { type: "business" as const, companyRut: options.bankQuery } : undefined);
  if (scope?.type === "business") {
    return scrapeScotiabankEmpresas(session, options, scope.companyRut);
  }
  return scrapeScotiabankPersonas(session, options);
}

/** Portal Empresas — login smoke + MFA; extraction WIP after we map the home DOM. */
async function scrapeScotiabankEmpresas(
  session: BrowserSession,
  options: ScraperOptions,
  companyRut: string | undefined,
): Promise<ScrapeResult> {
  const { rut, password, saveScreenshots: doScreenshots, onProgress } = options;
  const { page, debugLog, screenshot: doSave } = session;
  const progress = onProgress || (() => {});
  const bank = "scotiabank";

  const rawEmpresa =
    companyRut ||
    process.env.SCOTIABANK_EMPRESA_RUT ||
    process.env.SCOTIABANK_COMPANY_RUT;
  // Ignore placeholder typos like "RUT_EMPRESA" (no digits) and fall back to .env
  const empresaRut =
    rawEmpresa && /\d/.test(rawEmpresa)
      ? rawEmpresa
      : process.env.SCOTIABANK_EMPRESA_RUT || process.env.SCOTIABANK_COMPANY_RUT;
  if (!empresaRut || !/\d/.test(empresaRut)) {
    return {
      success: false,
      bank,
      accounts: [],
      error:
        "Scotia Empresas requiere RUT empresa real: --scope business:78053686-1 o SCOTIABANK_EMPRESA_RUT en .env",
      debug: debugLog.join("\n"),
    };
  }

  debugLog.push("1. [Empresas] Navigating to Portal Empresas login...");
  progress("Abriendo Portal Empresas...");
  await page.goto(EMPRESA_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await delay(4000);

  try {
    await page.waitForSelector(
      "#login-business-content-card-form-input-dni-business-input, input[name='bussinessId'], input[placeholder*='Empresa']",
      { visible: true, timeout: 30000 },
    );
  } catch {
    const ss = await page.screenshot({ encoding: "base64" });
    return {
      success: false,
      bank,
      accounts: [],
      error: "No se cargó el formulario Portal Empresas (RUT Empresa).",
      screenshot: ss as string,
      debug: debugLog.join("\n"),
    };
  }
  await doSave(page, "01-empresa-login");
  debugLog.push(`  Login URL: ${page.url()}`);

  const empresaFmt = formatRutDash(empresaRut);
  const userFmt = formatRutDash(rut);

  const empresaSel = "#login-business-content-card-form-input-dni-business-input";
  const userSel = "#login-business-content-card-form-input-dni-input";
  const passSel = "#login-business-content-card-form-input-password-input";

  debugLog.push(`2. [Empresas] Filling RUT Empresa (${empresaFmt})...`);
  progress("Ingresando RUT empresa...");
  const empresaInput = await page.$(empresaSel) || await page.$("input[name='bussinessId']");
  if (!empresaInput) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, bank, accounts: [], error: "No se encontró RUT Empresa", screenshot: ss as string, debug: debugLog.join("\n") };
  }
  await empresaInput.click({ clickCount: 3 });
  await empresaInput.type(empresaFmt, { delay: 50 });

  debugLog.push(`3. [Empresas] Filling RUT Usuario (${userFmt})...`);
  progress("Ingresando RUT usuario...");
  const userInput = await page.$(userSel) || await page.$("input[name='userId']");
  if (!userInput) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, bank, accounts: [], error: "No se encontró RUT Usuario", screenshot: ss as string, debug: debugLog.join("\n") };
  }
  await userInput.click({ clickCount: 3 });
  await userInput.type(userFmt, { delay: 50 });

  debugLog.push("4. [Empresas] Filling Clave...");
  progress("Ingresando clave...");
  const passInput = await page.$(passSel) || await page.$("input[name='pass']");
  if (!passInput) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, bank, accounts: [], error: "No se encontró Clave", screenshot: ss as string, debug: debugLog.join("\n") };
  }
  await passInput.click({ clickCount: 3 });
  await passInput.type(password, { delay: 50 });
  await doSave(page, "02-empresa-credentials");

  // Login gate is captcha (no ScotiaPass on entry).
  // ponytail: never auto-fill captcha — DOM/OCR guesses the wrong/stale code.
  if (await hasEmpresaCaptcha(page)) {
    debugLog.push("5. [Empresas] Captcha detectado — completar manualmente en Chrome...");
    await doSave(page, "02b-empresa-captcha");
    progress("Escribe el captcha actual y pulsa Ingresar en Chrome...");
    const left = await waitUntilNotLogin(page, debugLog, EMPRESA_2FA_CONFIG);
    if (!left) {
      const ss = await page.screenshot({ encoding: "base64" }).catch(() => undefined);
      return {
        success: false,
        bank,
        accounts: [],
        error: "Timeout en captcha/login Empresas (escribe el captcha e Ingresar en Chrome).",
        screenshot: ss as string | undefined,
        debug: debugLog.join("\n"),
      };
    }
    // OAuth redirect → /portalempresas/home; wait for layout before screenshots
    await settleEmpresaHome(page, debugLog);
  } else {
    debugLog.push("5. [Empresas] Submitting (sin captcha)...");
    progress("Iniciando sesión...");
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find(
        (b) => (b.innerText || "").trim().toLowerCase() === "ingresar",
      ) as HTMLButtonElement | undefined;
      if (btn && !btn.disabled) btn.click();
    });
    await delay(5000);
  }
  await doSave(page, "03-empresa-after-submit");

  // Optional post-login challenge (user reports login itself has no ScotiaPass)
  if ((await detect2FA(page, EMPRESA_2FA_CONFIG)) || (await looksLikeEmpresaMfa(page))) {
    debugLog.push("6. [Empresas] Challenge extra detectado (no esperado en login)...");
    progress("Completa el challenge en Chrome si aparece...");
    await waitFor2FA(page, debugLog, EMPRESA_2FA_CONFIG);
  }
  if (/mfe-login|portalempresas\/login/i.test(page.url())) {
    const left = await waitUntilNotLogin(page, debugLog, EMPRESA_2FA_CONFIG);
    if (!left) {
      return {
        success: false,
        bank,
        accounts: [],
        error: "Sigue en login Empresas tras captcha — revisa credenciales/captcha.",
        debug: debugLog.join("\n"),
      };
    }
    await settleEmpresaHome(page, debugLog);
  }

  await closePopups(page);
  await doSave(page, "04-empresa-after-login");

  if (/mfe-login|portalempresas\/login/i.test(page.url())) {
    const err = await page.evaluate(() => {
      const text = (document.body?.innerText || "").toLowerCase();
      if (/clave|rut|incorrect|inválid|bloque|error|intent/.test(text)) {
        const lines = (document.body?.innerText || "").split("\n").map((l) => l.trim()).filter(Boolean);
        return lines.find((l) => /clave|rut|incorrect|inválid|bloque|error/i.test(l) && l.length < 160) || null;
      }
      return null;
    }).catch(() => null);
    return {
      success: false,
      bank,
      accounts: [],
      error: err || `Login Empresas no completó (URL: ${page.url()})`,
      debug: debugLog.join("\n"),
    };
  }

  debugLog.push(`  Login OK — URL: ${page.url()}`);
  progress("Sesión Empresas iniciada");
  await settleEmpresaHome(page, debugLog);
  await doSave(page, "05-empresa-dashboard");

  debugLog.push("7. [Empresas] Abriendo Cuentas...");
  progress("Navegando a Cuentas...");
  const clickedCuentas = await clickEmpresaNav(page, /^cuentas$/i);
  if (!clickedCuentas) {
    debugLog.push("  No se encontró menú 'Cuentas'");
  } else {
    debugLog.push(`  Clicked nav: ${clickedCuentas}`);
    await delay(4000);
    await settleEmpresaHome(page, debugLog);
  }
  await doSave(page, "06-empresa-cuentas");
  debugLog.push(`  Cuentas URL: ${page.url()}`);

  const cuentasMap = await page.evaluate(() => {
    const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
    return { snippet: text.slice(0, 900) };
  }).catch(() => ({ snippet: "" }));
  debugLog.push(`  Cuentas snippet: ${cuentasMap.snippet}`);

  // Capture account cards on /products before drilling into a row
  let accounts = await extractEmpresaAccountsPage(page);
  debugLog.push(`  Accounts on products: ${accounts.length}`);
  for (const a of accounts) debugLog.push(`    - ${a.label}: ${a.balance ?? "?"}`);

  // Select Cuenta Corriente so "Últimos movimientos" loads that account's rows
  const sub = await clickEmpresaNav(page, /cuenta corriente\s*\(/i);
  if (sub) {
    debugLog.push(`  Selected account: ${sub}`);
    await delay(3500);
  }

  const tab = await clickEmpresaNav(page, /^[úu]ltimos movimientos$/i);
  if (tab) {
    debugLog.push(`  Tab: ${tab}`);
    await delay(2000);
  }

  // Wait until movement rows render (do NOT click global icon-arrow — leaves Cuentas)
  await waitForEmpresaMovements(page, debugLog);
  await doSave(page, "07-empresa-cuenta-detalle");

  // Re-read accounts if first pass missed (DOM may hydrate late)
  if (accounts.length === 0) {
    accounts = await extractEmpresaAccountsPage(page);
    debugLog.push(`  Accounts retry: ${accounts.length}`);
  }

  const bodyText = await page.evaluate(() => (document.body?.innerText || "").replace(/\u00a0/g, " "));
  if (/no se encontraron registros/i.test(bodyText)) {
    debugLog.push("  Aviso UI: 'No se encontraron registros' en movimientos");
  }
  await doSave(page, "07b-empresa-movimientos");
  type RawMov = { date: string; description: string; amount: string; balance: string; tipo: string };
  const fromText = parseEmpresaMovementsText(bodyText).map((r: RawMov) => {
    let amount = parseChileanAmount(r.amount);
    if (r.tipo === "cargo") amount = -Math.abs(amount);
    else amount = Math.abs(amount);
    return {
      date: normalizeDate(r.date),
      description: r.description || "Movimiento",
      amount,
      balance: r.balance ? parseChileanAmount(r.balance) : 0,
      source: MOVEMENT_SOURCE.account,
    } satisfies BankMovement;
  }).filter((m: BankMovement) => m.amount !== 0);
  const movs = deduplicateMovements([
    ...await extractEmpresaMovements(page),
    ...fromText,
  ]);
  debugLog.push(`  Movements on page: ${movs.length}`);

  const clpIdx = accounts.findIndex((a) => /corriente|vista|ahorro/i.test(a.label) && !/d[oó]lar/i.test(a.label));
  const attachIdx = clpIdx >= 0 ? clpIdx : 0;
  if (accounts.length > 0) {
    accounts = accounts.map((a, i) => (i === attachIdx ? { ...a, movements: movs } : a));
  } else if (movs.length > 0) {
    accounts = [{ label: "Cuenta Corriente", movements: movs }];
  }

  progress(`Listo — ${accounts.length} cuentas, ${movs.length} movimientos`);
  await doSave(page, "08-empresa-final");
  let ss: string | undefined;
  if (doScreenshots) {
    try {
      ss = (await page.screenshot({ encoding: "base64", fullPage: true })) as string;
    } catch {
      /* non-fatal */
    }
  }

  return {
    success: true,
    bank,
    accounts: accounts.length ? accounts : [{ label: "Scotia Empresas (WIP)", movements: [] }],
    screenshot: ss,
    debug: debugLog.join("\n"),
  };
}

async function clickEmpresaNav(page: Page, label: RegExp): Promise<string | null> {
  return page.evaluate((patternSrc) => {
    const re = new RegExp(patternSrc, "i");
    const candidates = Array.from(document.querySelectorAll("a, button, [role='tab'], [role='menuitem'], span, li, div"));
    for (const el of candidates) {
      const t = ((el as HTMLElement).innerText || "").replace(/\s+/g, " ").trim();
      if (!t || t.length > 60) continue;
      if (!re.test(t)) continue;
      // Prefer top-nav / menu items (not huge blocks)
      const rect = (el as HTMLElement).getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.height > 80) continue;
      (el as HTMLElement).click();
      return t;
    }
    return null;
  }, label.source);
}

async function extractEmpresaAccountsPage(
  page: Page,
): Promise<Array<{ label: string; balance?: number; movements: BankMovement[] }>> {
  const body = await page.evaluate(() => (document.body?.innerText || "").replace(/\u00a0/g, " "));
  return parseEmpresaAccountsText(body);
}

/** Pure parser for /products account cards. */
export function parseEmpresaAccountsText(
  text: string,
): Array<{ label: string; balance?: number; movements: BankMovement[] }> {
  const normalized = text.replace(/\u00a0/g, " ");
  const out: Array<{ label: string; balance?: number; movements: BankMovement[] }> = [];
  const seen = new Set<string>();
  const re =
    /(Cuenta\s+Corriente|Cuenta\s+Vista|Cuenta\s+D[oó]lar|Cuenta\s+de\s+Ahorro)\s*\(([^)]+)\)\s*(?:\$|USD)\s*([\d.]+(?:,\d{1,2})?)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(normalized)) !== null) {
    const label = `${m[1]} (${m[2]})`.replace(/\s+/g, " ").trim();
    if (seen.has(label)) continue;
    seen.add(label);
    out.push({ label, balance: parseChileanAmount(m[3]), movements: [] });
  }
  return out.slice(0, 10);
}

async function expandEmpresaMovementRows(page: Page, debugLog: string[]): Promise<void> {
  // Scoped only under Últimos movimientos — global .icon-arrow-1-right navigates away (Inicio).
  const n = await page.evaluate(() => {
    const root =
      Array.from(document.querySelectorAll("section, div, main")).find((el) =>
        /[úu]ltimos movimientos/i.test((el as HTMLElement).innerText || ""),
      ) || document.body;
    const arrows = Array.from(
      root.querySelectorAll("table span.icon-arrow-1-right, table .icon-arrow-1-right, tbody .icon-arrow-1-right"),
    );
    let clicked = 0;
    for (const el of arrows.slice(0, 30)) {
      try {
        (el as HTMLElement).click();
        clicked++;
      } catch {
        /* ignore */
      }
    }
    return clicked;
  }).catch(() => 0);
  debugLog.push(`  Expanded movement rows via arrow: ${n}`);
}

async function waitForEmpresaMovements(page: Page, debugLog: string[]): Promise<void> {
  try {
    await page.waitForFunction(
      () => {
        const t = document.body?.innerText || "";
        if (/no se encontraron registros/i.test(t) && !/TEF\s+\d/i.test(t)) return false;
        return (
          /\d{1,2}\s+(Ene|Feb|Mar|Abr|May|Jun|Jul|Ago|Sep|Oct|Nov|Dic)[a-z]*,?\s+\d{4}/i.test(t) &&
          /\$\s*[\d.]+/.test(t) &&
          /N[°º]?\s*OPERACI/i.test(t)
        );
      },
      { timeout: 20000 },
    );
    debugLog.push("  Movements table visible");
  } catch {
    debugLog.push("  Timeout esperando filas de movimientos — sigo igual");
  }
  await delay(1000);
}

/**
 * Parse Scotia Emp "Últimos movimientos" text.
 * Avoid matching RUT digits (e.g. 78334698-2) as Nº operación — ops are 10+ digits without hyphen.
 */
export function parseEmpresaMovementsText(text: string): Array<{
  date: string;
  description: string;
  amount: string;
  balance: string;
  tipo: string;
}> {
  const full = text.replace(/\u00a0/g, " ");
  const start = full.search(/[Úú]ltimos movimientos/i);
  const chunk = start >= 0 ? full.slice(start) : full;
  const out: Array<{ date: string; description: string; amount: string; balance: string; tipo: string }> = [];
  const tipoFromMonto = (monto: string) =>
    /^-|−|–/.test(monto.trim()) || monto.includes("-$") ? "cargo" : "abono";

  const rowRe =
    /(\d{1,2}\s+[A-Za-zÁÉÍÓÚáéíóú]{3},?\s+\d{4})\s+(.+?)\s+(\d{9,})(?!-\d)\s+([+\-−–]?\$\s*[\d.]+(?:,\d{1,2})?)\s+(\$\s*[\d.]+(?:,\d{1,2})?)/g;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(chunk)) !== null) {
    const desc = m[2].replace(/\s+/g, " ").trim();
    if (/^(FECHA|DESCRIPCI|MONTO|SALDO)/i.test(desc)) continue;
    out.push({
      date: m[1],
      description: desc,
      amount: m[4],
      balance: m[5],
      tipo: tipoFromMonto(m[4]),
    });
  }
  return out;
}

async function extractEmpresaMovements(page: Page): Promise<BankMovement[]> {
  const raw = await page.evaluate(() => {
    const results: Array<{ date: string; description: string; amount: string; balance: string; tipo: string }> = [];
    const looksLikeDate = (s: string) =>
      /\d{1,2}\s+[A-Za-zÁÉÍÓÚáéíóú]{3},?\s+\d{4}/.test(s) || /\d{1,2}[\/\-.]\d{1,2}/.test(s);
    const tipoFromMonto = (monto: string) =>
      /^-|−|–/.test(monto.trim()) || monto.includes("-$") ? "cargo" : "abono";

    for (const table of Array.from(document.querySelectorAll("table"))) {
      const rows = Array.from(table.querySelectorAll("tr"));
      let dateIdx = -1, descIdx = -1, amountIdx = -1, saldoIdx = -1;
      for (const row of rows) {
        const cells = row.querySelectorAll("th, td");
        if (cells.length < 2) continue;
        const headers = Array.from(cells).map((c) => ((c as HTMLElement).innerText || "").trim().toLowerCase());
        if (!headers.some((h) => h.includes("fecha"))) continue;
        dateIdx = headers.findIndex((h) => h.includes("fecha"));
        descIdx = headers.findIndex((h) => /descrip|detalle|glosa/.test(h));
        saldoIdx = headers.findIndex((h) => h.includes("saldo"));
        amountIdx = headers.findIndex((h) => /monto|importe/.test(h));
        break;
      }
      if (dateIdx < 0 || amountIdx < 0) continue;
      for (const row of rows) {
        const vals = Array.from(row.querySelectorAll("td")).map((c) =>
          ((c as HTMLElement).innerText || "").replace(/\s+/g, " ").trim(),
        );
        if (vals.length < 3) continue;
        const date = vals[dateIdx] || "";
        if (!looksLikeDate(date)) continue;
        const amount = vals[amountIdx] || "";
        if (!/\$/.test(amount)) continue;
        results.push({
          date,
          description: descIdx >= 0 ? vals[descIdx] || "" : vals[1] || "",
          amount,
          balance: saldoIdx >= 0 ? vals[saldoIdx] || "" : "",
          tipo: tipoFromMonto(amount),
        });
      }
    }
    return results;
  });

  return raw
    .map((r) => {
      let amount = parseChileanAmount(r.amount);
      if (r.tipo === "cargo") amount = -Math.abs(amount);
      else amount = Math.abs(amount);
      if (!amount) return null;
      return {
        date: normalizeDate(r.date),
        description: r.description || "Movimiento",
        amount,
        balance: r.balance ? parseChileanAmount(r.balance) : 0,
        source: MOVEMENT_SOURCE.account,
      } satisfies BankMovement;
    })
    .filter(Boolean) as BankMovement[];
}

async function settleEmpresaHome(page: Page, debugLog: string[]): Promise<void> {
  try {
    await page.setViewport({ width: 1280, height: 900 });
  } catch {
    /* ignore */
  }
  try {
    await page.waitForFunction(
      () => document.readyState === "complete" && (document.body?.innerText || "").length > 50,
      { timeout: 20000 },
    );
  } catch {
    debugLog.push("  Home aún cargando (timeout waitForFunction) — sigo igual");
  }
  await delay(2500);
}

async function hasEmpresaCaptcha(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const input = document.querySelector(
      'input[placeholder*="captcha" i], input[name*="captcha" i], input[id*="captcha" i]',
    );
    if (input) return true;
    const text = (document.body?.innerText || "").toLowerCase();
    return text.includes("ingrese captcha") || text.includes("ingresa captcha");
  });
}

async function looksLikeEmpresaMfa(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    // Still on login form with password → not MFA yet
    if (document.querySelector("#login-business-content-card-form-input-password-input")) return false;
    const text = (document.body?.innerText || "").toLowerCase();
    return /scotiapass|clave din[aá]mica|aprueba la|autoriza en|desaf[ií]o/.test(text);
  });
}

async function waitUntilNotLogin(
  page: Page,
  debugLog: string[],
  config: { timeoutEnvVar?: string; defaultTimeoutSec?: number },
): Promise<boolean> {
  const envValue = config.timeoutEnvVar ? process.env[config.timeoutEnvVar] : undefined;
  const timeoutSec = Math.min(
    600,
    Math.max(30, parseInt(envValue || String(config.defaultTimeoutSec || 180), 10) || 180),
  );
  const start = Date.now();
  while ((Date.now() - start) / 1000 < timeoutSec) {
    try {
      const url = page.url();
      // Login gate = stay on mfe-login / portalempresas. URL change = success.
      if (!/mfe-login|portalempresas\/login/i.test(url)) {
        debugLog.push(`  Fuera del login Empresas — URL: ${url}`);
        return true;
      }
      await delay(1500);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Expected while Chrome navigates after captcha / Ingresar
      if (/Execution context was destroyed|detached Frame|Target closed|Navigation|net::ERR/i.test(msg)) {
        await delay(2000);
        try {
          const url = page.url();
          if (!/mfe-login|portalempresas\/login/i.test(url)) {
            debugLog.push(`  Fuera del login Empresas (post-nav) — URL: ${url}`);
            return true;
          }
        } catch {
          /* still navigating */
        }
        continue;
      }
      throw err;
    }
  }
  debugLog.push(`  Timeout esperando salida de login Empresas (${timeoutSec}s).`);
  return false;
}

async function scrapeScotiabankPersonas(session: BrowserSession, options: ScraperOptions): Promise<ScrapeResult> {
  const { rut, password, saveScreenshots: doScreenshots, onProgress } = options;
  const { page, debugLog, screenshot: doSave } = session;
  const progress = onProgress || (() => {});
  const bank = "scotiabank";

  // 1. Navigate
  debugLog.push("1. Navigating to Scotiabank...");
  progress("Abriendo sitio del banco...");
  await page.goto(BANK_URL, { waitUntil: "networkidle2", timeout: 30000 });
  await delay(2000);
  await dismissBanners(page);
  await doSave(page, "01-homepage");

  // 2. Login
  debugLog.push("2. Clicking login button...");
  await page.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll("a, button"))) {
      const text = (el as HTMLElement).innerText?.trim().toLowerCase() || "";
      const href = (el as HTMLAnchorElement).href || "";
      if (text === "ingresar" || text === "acceso clientes" || text.includes("iniciar sesión") || href.includes("login") || href.includes("auth")) {
        (el as HTMLElement).click(); return;
      }
    }
  });
  await delay(4000);
  await doSave(page, "02-login-form");

  debugLog.push("3. Filling RUT...");
  progress("Ingresando RUT...");
  if (!(await fillRut(page, rut, LOGIN_SELECTORS))) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, bank, accounts: [], error: "No se encontró campo de RUT", screenshot: ss as string, debug: debugLog.join("\n") };
  }
  await delay(1000);

  debugLog.push("4. Filling password...");
  let passOk = await fillPassword(page, password, LOGIN_SELECTORS);
  if (!passOk) { await page.keyboard.press("Enter"); await delay(3000); passOk = await fillPassword(page, password, LOGIN_SELECTORS); }
  if (!passOk) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, bank, accounts: [], error: "No se encontró campo de clave", screenshot: ss as string, debug: debugLog.join("\n") };
  }
  await delay(800);

  debugLog.push("5. Submitting login...");
  progress("Iniciando sesión...");
  await clickSubmit(page, page, LOGIN_SELECTORS);
  await delay(8000);
  await doSave(page, "03-after-login");

  // 2FA check
  const pageContent = (await page.content()).toLowerCase();
  if (pageContent.includes("clave dinámica") || pageContent.includes("segundo factor") || pageContent.includes("código de verificación") || pageContent.includes("token")) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, bank, accounts: [], error: "El banco pide clave dinámica o 2FA.", screenshot: ss as string, debug: debugLog.join("\n") };
  }

  const loginError = await detectLoginError(page);
  if (loginError) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, bank, accounts: [], error: `Error del banco: ${loginError}`, screenshot: ss as string, debug: debugLog.join("\n") };
  }

  debugLog.push("6. Login OK!");
  progress("Sesión iniciada correctamente");
  await closePopups(page);
  await dismissScotiaTutorial(page, debugLog);

  // 7. Navigate to cartola
  debugLog.push("7. Looking for Cartola/Movimientos...");
  progress("Buscando cartola de cuenta...");
  await navigateToMovements(page, debugLog);
  await dismissScotiaTutorial(page, debugLog);

  // Wait for movements table to load (spinner to disappear)
  debugLog.push("7b. Waiting for movements to load...");
  progress("Esperando carga de movimientos...");
  const startWait = Date.now();
  while (Date.now() - startWait < 20000) {
    const hasTable = await page.evaluate(new Function(`${allDeepJs()}
      // Check if a table with rows OR movement cards exist
      const tables = allDeep(document, "table");
      for (const t of tables) { if (t.querySelectorAll("tr").length > 1) return "table"; }
      // Check for card-style movements
      const cards = allDeep(document, "[class*='mov'], [class*='tran'], [class*='transaction']");
      if (cards.length > 0) return "cards";
      // Check if spinner is gone and there's text with amounts
      const body = document.body?.innerText || "";
      if (/\\$\\s*[\\d.]+/.test(body) && body.length > 500) return "text";
      return null;`) as () => string | null);
    if (hasTable) { debugLog.push(`  Content loaded: ${hasTable}`); break; }
    await delay(2000);
  }

  await doSave(page, "04-movements-page");

  // 8. Try expanding date range
  try {
    const selectInfo = await page.evaluate(() => {
      const selects = Array.from(document.querySelectorAll("select"));
      return selects.map((sel, i) => ({
        index: i, name: sel.name || sel.id || `select-${i}`,
        options: Array.from(sel.querySelectorAll("option")).map((o) => ({ text: o.text.trim(), value: o.value })),
      }));
    });
    for (const sel of selectInfo) {
      for (const opt of sel.options) {
        const text = opt.text.toLowerCase();
        if (text.includes("todos") || text.includes("último mes") || text.includes("30 día") || text.includes("mes anterior")) {
          await page.evaluate((selIdx: number, optValue: string) => {
            const selects = document.querySelectorAll("select");
            const select = selects[selIdx] as HTMLSelectElement;
            if (select) { select.value = optValue; select.dispatchEvent(new Event("change", { bubbles: true })); }
          }, sel.index, opt.value);
          await delay(3000);
          break;
        }
      }
    }
  } catch { /* ignore */ }

  // 9. Extract current period
  const movements = await scotiaPaginate(page, debugLog);
  debugLog.push(`9. Extracted ${movements.length} movements (current period)`);
  progress(`Periodo actual: ${movements.length} movimientos`);

  // 10. Historical periods via "Consultar Cartolas" (month/year dropdowns)
  const months = Math.min(Math.max(parseInt(process.env.SCOTIABANK_MONTHS || "3", 10) || 3, 0), 12);
  if (months > 0) {
    debugLog.push(`10. Fetching ${months} historical cartola(s)...`);
    progress(`Extrayendo cartolas históricas...`);

    // Navigate to Cartolas via sidebar: Cuentas → Cuenta Corriente → Ver cartolas
    // Step 1: Click "Cuentas" in sidebar
    await page.evaluate(new Function(`${allDeepJs()}
      for (const el of allDeep(document, "nav a, nav button, aside a, aside button, a, button, li, span")) {
        const text = el.innerText?.trim().toLowerCase() || "";
        if (text === "cuentas" && text.length < 15) { el.click(); return true; }
      }
      return false;`) as () => boolean);
    debugLog.push("  Sidebar: Cuentas");
    await delay(2000);

    // Step 2: Click "Cuenta Corriente" submenu
    await page.evaluate(new Function(`${allDeepJs()}
      for (const el of allDeep(document, "a, button, li, span")) {
        const text = el.innerText?.trim().toLowerCase() || "";
        if (text === "cuenta corriente" && text.length < 25) { el.click(); return true; }
      }
      return false;`) as () => boolean);
    debugLog.push("  Sidebar: Cuenta Corriente");
    await delay(2000);

    // Step 3: Navigate to Cartolas tab — try URL param change first, then click
    const currentUrl = page.url();
    let clickedVerCartolas = false;

    // Try URL-based navigation (change tab=saldos to tab=cartolas)
    if (currentUrl.includes("tab=saldos") || currentUrl.includes("balancesmovements")) {
      const cartolasUrl = currentUrl.includes("tab=")
        ? currentUrl.replace(/tab=[^&]+/, "tab=cartolas")
        : currentUrl + (currentUrl.includes("?") ? "&" : "?") + "tab=cartolas";
      try {
        await page.goto(cartolasUrl, { waitUntil: "networkidle2", timeout: 15000 });
        clickedVerCartolas = true;
        debugLog.push("  Navigated to Cartolas tab via URL");
      } catch { /* fallback below */ }
    }

    // Fallback: click "Ver cartolas" or "Cartolas" tab
    if (!clickedVerCartolas) {
      clickedVerCartolas = await page.evaluate(new Function(`${allDeepJs()}
        for (const el of allDeep(document, "a, button, li, span")) {
          const text = el.innerText?.trim().toLowerCase() || "";
          if (text === "ver cartolas" || text.includes("ver cartola")) { el.click(); return true; }
        }
        return false;`) as () => boolean);
    }
    if (!clickedVerCartolas) {
      clickedVerCartolas = await page.evaluate(new Function(`${allDeepJs()}
        for (const el of allDeep(document, "a, button, [role='tab'], li, span")) {
          const text = el.innerText?.trim().toLowerCase() || "";
          if (text === "cartolas" && text.length < 20) { el.click(); return true; }
        }
        return false;`) as () => boolean);
    }

    if (clickedVerCartolas) {
      debugLog.push("  On Cartolas tab");
      await delay(4000);
      await dismissScotiaTutorial(page, debugLog);

      // Click "Consultar Cartolas" — check main page + all frames
      let clickedConsultar = await page.evaluate(new Function(`${allDeepJs()}
        for (const el of allDeep(document, "a, button, span")) {
          const text = el.innerText?.trim().toLowerCase() || "";
          if (text.includes("consultar cartola") && text.length < 40) { el.click(); return true; }
        }
        return false;`) as () => boolean);

      // Try frames if not found in main page
      if (!clickedConsultar) {
        for (const frame of page.frames()) {
          if (frame === page.mainFrame()) continue;
          try {
            clickedConsultar = await frame.evaluate(() => {
              for (const el of document.querySelectorAll("a, button, span, div")) {
                const text = (el as HTMLElement).innerText?.trim().toLowerCase() || "";
                if (text.includes("consultar cartola") && text.length < 40) {
                  (el as HTMLElement).click(); return true;
                }
              }
              return false;
            });
            if (clickedConsultar) { debugLog.push("  Found Consultar Cartolas in iframe"); break; }
          } catch { /* detached */ }
        }
      }

      if (clickedConsultar) {
        debugLog.push("  Clicked: Consultar Cartolas");
        await delay(5000);
        await doSave(page, "06-consultar-cartolas");

        const MONTH_NAMES = ["enero", "febrero", "marzo", "abril", "mayo", "junio",
          "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
        const now = new Date();

        for (let m = 0; m < months; m++) {
          const target = new Date(now.getFullYear(), now.getMonth() - m, 1);
          const targetMonth = target.getMonth(); // 0-based
          const targetYear = target.getFullYear();
          debugLog.push(`  Cartola: ${MONTH_NAMES[targetMonth]} ${targetYear}`);
          progress(`Cartola ${MONTH_NAMES[targetMonth]} ${targetYear}...`);

          // Try to select month/year in dropdowns (check all frames)
          const frames = [page.mainFrame(), ...page.frames().filter((f) => f !== page.mainFrame())];
          let submitted = false;

          // Debug: list frames and their select counts
          for (const frame of frames) {
            try {
              const info = await frame.evaluate(() => {
                const selects = document.querySelectorAll("select");
                const inputs = document.querySelectorAll("input");
                const buttons = document.querySelectorAll("button, input[type='submit'], input[type='button'], input[type='image']");
                return { url: window.location.href, selects: selects.length, inputs: inputs.length, buttons: buttons.length };
              });
              debugLog.push(`    Frame: ${info.url.substring(0, 80)} | selects=${info.selects} inputs=${info.inputs} buttons=${info.buttons}`);
            } catch { /* detached */ }
          }

          for (const frame of frames) {
            try {
              // Debug: dump select options
              const selectDebug = await frame.evaluate(() => {
                const selects = Array.from(document.querySelectorAll("select")) as HTMLSelectElement[];
                return selects.map((sel, i) => ({
                  index: i, name: sel.name || sel.id,
                  options: Array.from(sel.options).map(o => ({ text: o.text.trim(), value: o.value })),
                }));
              }).catch(() => []);
              if (selectDebug.length > 0) {
                if (selectDebug.length > 0) debugLog.push(`    Frame has ${selectDebug.length} selects`);
              }

              const filled = await frame.evaluate((monthIdx: number, year: number) => {
                const selects = Array.from(document.querySelectorAll("select")) as HTMLSelectElement[];
                if (selects.length < 1) return "no selects";

                // Use first two selects directly (month, year)
                const monthSelect = selects[0];
                const yearSelect = selects.length >= 2 ? selects[1] : null;
                if (!yearSelect) return "only 1 select";

                // Set month by value (01-12)
                const monthValue = String(monthIdx + 1).padStart(2, "0");
                monthSelect.value = monthValue;
                monthSelect.dispatchEvent(new Event("change", { bubbles: true }));

                // Set year
                yearSelect.value = String(year);
                yearSelect.dispatchEvent(new Event("change", { bubbles: true }));

                return "ok";
              }, targetMonth, targetYear);

              debugLog.push(`    Fill result: ${filled}`);
              if (filled !== "ok") continue;

              await delay(500);

              // Click "Aceptar" (could be button, submit, or image input)
              const accepted = await frame.evaluate(() => {
                for (const el of document.querySelectorAll('button, input[type="submit"], input[type="button"], input[type="image"], a, img')) {
                  const text = ((el as HTMLElement).innerText?.trim() || (el as HTMLInputElement).value || (el as HTMLInputElement).alt || "").toLowerCase();
                  if (text.includes("aceptar") || text === "buscar" || text === "consultar" || text === "enviar") {
                    (el as HTMLElement).click(); return text;
                  }
                }
                // Last resort: click any submit-like element
                const submit = document.querySelector('input[type="submit"], input[type="image"]') as HTMLElement;
                if (submit) { submit.click(); return "submit-fallback"; }
                return null;
              });
              debugLog.push(`    Accepted: ${accepted}`);

              if (accepted) {
                debugLog.push(`    Submitted: ${MONTH_NAMES[targetMonth]} ${targetYear}`);
                await delay(8000);

                // Wait for table to load
                const waitStart = Date.now();
                while (Date.now() - waitStart < 15000) {
                  const hasContent = await frame.evaluate(() => {
                    const tables = document.querySelectorAll("table");
                    for (const t of Array.from(tables)) { if (t.querySelectorAll("tr").length > 2) return true; }
                    return false;
                  }).catch(() => false);
                  if (hasContent) break;
                  await delay(2000);
                }

                await doSave(page, `07-cartola-${MONTH_NAMES[targetMonth]}-${targetYear}`);

                // Extract from this frame
                const periodMovements = await extractMovements(page);
                debugLog.push(`    Found: ${periodMovements.length} movements`);
                movements.push(...periodMovements);
                submitted = true;
                break;
              }
            } catch { /* detached frame */ }
          }

          if (!submitted) {
            debugLog.push(`    Could not submit cartola for ${MONTH_NAMES[targetMonth]} ${targetYear}`);
            break;
          }
        }
      } else {
        debugLog.push("  Could not click Consultar Cartolas");
      }
    } else {
      debugLog.push("  Could not navigate to Cartolas");
    }
  }

  const deduplicated = deduplicateMovements(movements);
  debugLog.push(`  Total: ${deduplicated.length} unique movements`);
  progress(`Listo — ${deduplicated.length} movimientos totales`);

  let balance: number | undefined;
  if (deduplicated.length > 0 && deduplicated[0].balance > 0) balance = deduplicated[0].balance;
  if (balance === undefined) {
    balance = await page.evaluate(() => {
      const bodyText = document.body?.innerText || "";
      const patterns = [/saldo disponible[\s\S]{0,50}\$\s*([\d.]+)/i, /saldo actual[\s\S]{0,50}\$\s*([\d.]+)/i];
      for (const pattern of patterns) { const match = bodyText.match(pattern); if (match) return parseInt(match[1].replace(/[^0-9]/g, ""), 10); }
      return undefined;
    });
  }

  await doSave(page, "05-final");
  const ss = doScreenshots ? (await page.screenshot({ encoding: "base64", fullPage: true })) as string : undefined;

  return { success: true, bank, accounts: [{ balance: balance ?? undefined, movements: deduplicated }], screenshot: ss, debug: debugLog.join("\n") };
}

// ─── Export ──────────────────────────────────────────────────────

const scotiabank: BankScraper = {
  id: "scotiabank",
  name: "Scotiabank Chile",
  url: BANK_URL,
  scrape: (options) => {
    const isBiz = options.scope?.type === "business" || !!options.empresa;
    return runScraper("scotiabank", options, { forceHeadful: isBiz }, scrapeScotiabank);
  },
};

export default scotiabank;
