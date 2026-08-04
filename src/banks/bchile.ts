import puppeteer, { type Page } from "puppeteer-core";
import type { BankMovement, BankScraper, CreditCardBalance, MovementSource, ScrapeResult, ScraperOptions, BankAccountInfo, BeneficiarioData } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { closePopups, delay, findChrome, formatRut, saveScreenshot, normalizeDate, deduplicateMovements, logout, normalizeInstallments } from "../utils.js";

const BANK_URL = "https://portalpersonas.bancochile.cl/persona/";
const API_BASE = "https://portalpersonas.bancochile.cl/mibancochile/rest/persona";

// Portal Empresas (cuentas empresa)
const EMPRESA_LOGIN_URL = "https://login.portalempresas.bancochile.cl/bancochile-web/empresa/login/index.html#/login";
const EMPRESA_DASHBOARD_URL = "https://portalempresas.bancochile.cl/mibancochile-web/front/empresa/index.html";
const EMPRESA_MOVIMIENTOS_URL = `${EMPRESA_DASHBOARD_URL}#/movimientos-cuentas/movimientos`;
const EMPRESA_API_BASE = "https://portalempresas.bancochile.cl/mibancochile/rest/empresa";

// ─── Helpers ──────────────────────────────────────────────────────

// ─── Login helpers ────────────────────────────────────────────────

async function fillRut(page: Page, rut: string, debugLog: string[]): Promise<boolean> {
  const formattedRut = formatRut(rut);
  const cleanRut = rut.replace(/[.\-]/g, "");

  const selectors = [
    "#ppriv_per-login-click-input-rut",
    'input[name="userRut"]',
    "#rut",
    'input[name="rut"]',
    'input[placeholder*="RUT"]',
    'input[placeholder*="Rut"]',
  ];

  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        // Use clean RUT for fields with short maxlength, formatted otherwise
        const maxLen = await page.evaluate((s: string) => {
          const input = document.querySelector(s) as HTMLInputElement | null;
          return input?.maxLength ?? -1;
        }, sel);
        const rutValue = (maxLen > 0 && maxLen <= 10) ? cleanRut : formattedRut;
        await el.click({ clickCount: 3 });
        await el.type(rutValue, { delay: 45 });
        debugLog.push(`  RUT filled using selector: ${sel}`);
        return true;
      }
    } catch {
      // Try next selector.
    }
  }

  // Last resort: find any visible text input
  try {
    const wasFilled = await page.evaluate((rutFormatted: string, rutClean: string) => {
      const candidates = Array.from(document.querySelectorAll("input"));
      for (const input of candidates) {
        const el = input as HTMLInputElement;
        if (el.offsetParent === null || el.disabled || el.type === "password") continue;
        el.focus();
        el.value = el.maxLength > 0 && el.maxLength <= 10 ? rutClean : rutFormatted;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
      return false;
    }, formattedRut, cleanRut);

    if (wasFilled) {
      debugLog.push("  RUT filled using generic input fallback");
      return true;
    }
  } catch {
    // ignore
  }

  debugLog.push("  RUT field not found");
  return false;
}

async function fillPassword(page: Page, password: string, debugLog: string[]): Promise<boolean> {
  const selectors = [
    "#ppriv_per-login-click-input-password",
    'input[name="userPassword"]',
    "#pass",
    "#password",
    'input[type="password"]',
    'input[name="password"]',
  ];

  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (!el) continue;

      // Check if input is readonly or disabled
      const isReadonly = await page.evaluate((selector: string) => {
        const input = document.querySelector(selector) as HTMLInputElement | null;
        if (!input) return false;
        return input.readOnly || input.disabled;
      }, sel);

      if (!isReadonly) {
        await el.click();
        await el.type(password, { delay: 45 });
        debugLog.push(`  Password filled using selector: ${sel}`);
        return true;
      }

      // Input is readonly/disabled — try virtual keyboard
      debugLog.push(`  Password field ${sel} is readonly/disabled, trying virtual keyboard...`);
      const keyboardSelectors = [
        '[class*="keyboard"]',
        '[class*="teclado"]',
        '[class*="virtual"]',
      ];

      let keyboardFound = false;
      for (const kbSel of keyboardSelectors) {
        const keyboard = await page.$(kbSel);
        if (keyboard) {
          keyboardFound = true;
          debugLog.push(`  Virtual keyboard found: ${kbSel}`);

          for (const char of password) {
            const clicked = await page.evaluate((ch: string, kbSelector: string) => {
              const kb = document.querySelector(kbSelector);
              if (!kb) return false;
              const buttons = Array.from(kb.querySelectorAll("button, span, div, a"));
              for (const btn of buttons) {
                const text = (btn as HTMLElement).innerText?.trim();
                if (text === ch) {
                  (btn as HTMLElement).click();
                  return true;
                }
              }
              return false;
            }, char, kbSel);

            if (!clicked) {
              debugLog.push("  Virtual keyboard: character not found");
              return false;
            }
          }

          debugLog.push("  Password filled using virtual keyboard");
          return true;
        }
      }

      if (!keyboardFound) {
        debugLog.push("  Virtual keyboard not found");
      }
    } catch {
      // Try next selector.
    }
  }

  debugLog.push("  Password field not found");
  return false;
}

async function clickSubmitButton(page: Page, debugLog: string[]): Promise<boolean> {
  const selectors = [
    "#ppriv_per-login-click-ingresar-login",
    'button[type="submit"]',
    "#btn-login",
    "#btn_login",
  ];

  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        debugLog.push(`  Submit clicked: ${sel}`);
        return true;
      }
    } catch {
      // Try next selector.
    }
  }

  // Fallback: find button by text
  const clicked = await page.evaluate(() => {
    const texts = ["ingresar", "continuar", "iniciar sesión"];
    const buttons = Array.from(document.querySelectorAll("button, a, input[type='submit']"));
    for (const btn of buttons) {
      const text = (btn as HTMLElement).innerText?.trim().toLowerCase() || "";
      if (texts.some((t) => text.includes(t))) {
        (btn as HTMLElement).click();
        return true;
      }
    }
    return false;
  });

  if (clicked) {
    debugLog.push("  Submit clicked via text fallback");
    return true;
  }

  debugLog.push("  Submit button not found");
  return false;
}

async function detectLoginError(page: Page): Promise<string | null> {
  return await page.evaluate(() => {
    const selectors = ['[class*="error"]', '[class*="alert"]', '[role="alert"]'];
    const errorTexts: string[] = [];

    for (const sel of selectors) {
      const elements = document.querySelectorAll(sel);
      for (const el of elements) {
        const text = (el as HTMLElement).innerText?.trim();
        if (text) errorTexts.push(text);
      }
    }

    const keywords = [
      "clave incorrecta",
      "rut inválido",
      "bloqueada",
      "bloqueado",
      "suspendida",
      "sesión activa",
      "ya tiene una sesión",
      "reactivar",
      "clave bloqueada",
      "clave suspendida",
    ];

    for (const text of errorTexts) {
      const lower = text.toLowerCase();
      for (const kw of keywords) {
        if (lower.includes(kw)) return text;
      }
    }

    return null;
  });
}

async function has2FAChallenge(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    const text = (document.body?.innerText || "").toLowerCase();
    return (
      text.includes("clave dinámica") ||
      text.includes("clave dinamica") ||
      text.includes("superclave") ||
      text.includes("segundo factor") ||
      text.includes("código de verificación") ||
      text.includes("codigo de verificacion") ||
      text.includes("ingresa tu token")
    );
  });
}

// ─── Login Empresa (Portal Empresas) ────────────────────────────────

function normalizeRutForEmpresa(rut: string): string {
  const clean = rut.replace(/[.\s]/g, "").toUpperCase();
  if (clean.includes("-")) return clean;
  if (clean.length < 2) return clean;
  const body = clean.slice(0, -1);
  const dv = clean.slice(-1);
  return `${body}-${dv}`;
}

async function fillRutEmpresa(page: Page, rut: string, debugLog: string[]): Promise<boolean> {
  const formattedRut = normalizeRutForEmpresa(rut);
  try {
    const el = await page.$("#iduserName");
    if (el) {
      await el.click({ clickCount: 3 });
      await el.type(formattedRut, { delay: 45 });
      debugLog.push("  RUT empresa filled (#iduserName)");
      return true;
    }
  } catch {
    // fallback
  }
  debugLog.push("  RUT empresa field not found");
  return false;
}

async function fillPasswordEmpresa(page: Page, password: string, debugLog: string[]): Promise<boolean> {
  try {
    const el = await page.$("#ppriv_emp-login-click-input-password");
    if (el) {
      await el.click();
      await el.type(password, { delay: 45 });
      debugLog.push("  Password empresa filled (#ppriv_emp-login-click-input-password)");
      return true;
    }
  } catch {
    // fallback
  }
  debugLog.push("  Password empresa field not found");
  return false;
}

async function clickSubmitEmpresa(page: Page, debugLog: string[]): Promise<boolean> {
  try {
    const el = await page.$("#idIngresar");
    if (el) {
      await el.click();
      debugLog.push("  Submit empresa clicked (#idIngresar)");
      return true;
    }
  } catch {
    // fallback
  }
  const clicked = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button")).find(
      (b) => (b as HTMLElement).innerText?.toLowerCase().includes("ingresar")
    );
    if (btn) { (btn as HTMLElement).click(); return true; }
    return false;
  });
  if (clicked) debugLog.push("  Submit empresa clicked via text");
  return clicked;
}

async function loginEmpresa(
  page: Page,
  rut: string,
  password: string,
  debugLog: string[],
  doSave: (page: Page, name: string) => Promise<void>
): Promise<{ success: boolean; error?: string; screenshot?: string }> {
  debugLog.push("1. Navigating to Portal Empresas login...");
  await page.goto(EMPRESA_LOGIN_URL, { waitUntil: "networkidle2", timeout: 45000 });
  await delay(3000);
  await doSave(page, "01-empresa-homepage");

  try {
    await page.waitForSelector("#iduserName", { timeout: 15000 });
  } catch {
    debugLog.push("  Empresa login form not found");
  }
  await delay(1000);

  debugLog.push("2. Filling RUT...");
  const rutFilled = await fillRutEmpresa(page, rut, debugLog);
  if (!rutFilled) {
    const screenshot = await page.screenshot({ encoding: "base64" });
    return { success: false, error: "No se encontró el campo de RUT", screenshot: screenshot as string };
  }
  await delay(500);

  debugLog.push("3. Filling password...");
  const passFilled = await fillPasswordEmpresa(page, password, debugLog);
  if (!passFilled) {
    const screenshot = await page.screenshot({ encoding: "base64" });
    return { success: false, error: "No se encontró el campo de clave", screenshot: screenshot as string };
  }

  await doSave(page, "02-empresa-pre-submit");
  debugLog.push("4. Submitting login...");
  await clickSubmitEmpresa(page, debugLog);

  try {
    await page.waitForNavigation({ timeout: 25000 });
  } catch {
    // SPA
  }
  await delay(5000);
  await doSave(page, "03-empresa-after-login");

  const loginError = await detectLoginError(page);
  if (loginError) {
    const screenshot = await page.screenshot({ encoding: "base64" });
    return { success: false, error: `Error de login: ${loginError}`, screenshot: screenshot as string };
  }

  if (await has2FAChallenge(page)) {
    const timeoutSec = Math.min(600, Math.max(30, parseInt(process.env.BCHILE_2FA_TIMEOUT_SEC || "180", 10)));
    const timeoutMs = timeoutSec * 1000;
    debugLog.push(`  2FA detectado. Esperando aprobación manual (${timeoutSec}s máx)...`);
    const deadline = Date.now() + timeoutMs;
    let pollCount = 0;
    while (Date.now() < deadline) {
      if (!(await has2FAChallenge(page))) break;
      if (pollCount % 10 === 0) {
        debugLog.push(`  Esperando aprobación... (${Math.round((deadline - Date.now()) / 1000)}s restantes)`);
      }
      pollCount++;
      await delay(1500);
    }
    if (await has2FAChallenge(page)) {
      const screenshot = await page.screenshot({ encoding: "base64" });
      return { success: false, error: "Timeout esperando aprobación de 2FA", screenshot: screenshot as string };
    }
  }

  const currentUrl = page.url();
  if (currentUrl.includes("login.portalempresas") && currentUrl.includes("/login")) {
    const screenshot = await page.screenshot({ encoding: "base64" });
    return { success: false, error: "Login failed — aún en página de login", screenshot: screenshot as string };
  }

  debugLog.push(`4. Login Empresa OK! URL: ${currentUrl}`);
  return { success: true };
}

// ─── Login ────────────────────────────────────────────────────────

async function login(
  page: Page,
  rut: string,
  password: string,
  debugLog: string[],
  doSave: (page: Page, name: string) => Promise<void>
): Promise<{ success: boolean; error?: string; screenshot?: string }> {
  debugLog.push("1. Navigating to bank homepage...");
  await page.goto(BANK_URL, { waitUntil: "networkidle2", timeout: 45000 });
  await delay(3000);
  await doSave(page, "01-homepage");

  // Wait for login form to appear (may redirect via OAuth)
  try {
    await page.waitForSelector('input[name="userRut"], input[name="rut"], #rut, input[placeholder*="RUT"]', { timeout: 15000 });
  } catch {
    debugLog.push("  Login form not found after waiting");
  }
  await delay(1000);
  await doSave(page, "01b-login-form");

  debugLog.push("2. Filling RUT...");
  const rutFilled = await fillRut(page, rut, debugLog);
  if (!rutFilled) {
    const screenshot = await page.screenshot({ encoding: "base64" });
    return { success: false, error: "No se encontró el campo de RUT", screenshot: screenshot as string };
  }
  await delay(500);

  debugLog.push("3. Filling password...");
  const passFilled = await fillPassword(page, password, debugLog);
  if (!passFilled) {
    // May be two-step: submit RUT first, then wait for password
    const submitted1 = await clickSubmitButton(page, debugLog);
    if (!submitted1) await page.keyboard.press("Enter");
    await delay(3000);
    await doSave(page, "02-after-rut-submit");

    const passFilled2 = await fillPassword(page, password, debugLog);
    if (!passFilled2) {
      const screenshot = await page.screenshot({ encoding: "base64" });
      return { success: false, error: "No se encontró el campo de clave", screenshot: screenshot as string };
    }
  }

  await doSave(page, "02-pre-submit");

  // Submit login
  debugLog.push("4. Submitting login...");
  const submitted = await clickSubmitButton(page, debugLog);
  if (!submitted) {
    await page.keyboard.press("Enter");
    debugLog.push("  Pressed Enter as fallback");
  }

  // Wait for navigation after login
  try {
    await page.waitForNavigation({ timeout: 25000 });
  } catch {
    // SPA may not trigger navigation event
  }

  await delay(5000);
  await doSave(page, "03-after-login");

  // Check for login errors
  const loginError = await detectLoginError(page);
  if (loginError) {
    const screenshot = await page.screenshot({ encoding: "base64" });
    return { success: false, error: `Error de login: ${loginError}`, screenshot: screenshot as string };
  }

  // Check for 2FA
  if (await has2FAChallenge(page)) {
    const timeoutSec = Math.min(600, Math.max(30, parseInt(process.env.BCHILE_2FA_TIMEOUT_SEC || "180", 10)));
    const timeoutMs = timeoutSec * 1000;
    debugLog.push(`  2FA detectado. Esperando aprobación manual (${timeoutSec}s máx)...`);
    const deadline = Date.now() + timeoutMs;
    let pollCount = 0;

    while (Date.now() < deadline) {
      if (!(await has2FAChallenge(page))) {
        debugLog.push("  2FA completado, continuando flujo.");
        break;
      }
      if (pollCount % 10 === 0) {
        const remaining = Math.round((deadline - Date.now()) / 1000);
        debugLog.push(`  Esperando aprobación... (${remaining}s restantes)`);
      }
      pollCount++;
      await delay(1500);
    }

    if (await has2FAChallenge(page)) {
      const screenshot = await page.screenshot({ encoding: "base64" });
      return { success: false, error: "Timeout esperando aprobación de 2FA", screenshot: screenshot as string };
    }
  }

  // Check if still on login page
  const currentUrl = page.url();
  if (currentUrl.includes("/login")) {
    const screenshot = await page.screenshot({ encoding: "base64" });
    return { success: false, error: "Login failed — aún en página de login", screenshot: screenshot as string };
  }

  debugLog.push(`4. Login OK!`);
  return { success: true };
}

// ─── REST API helpers ─────────────────────────────────────────────

async function apiGet<T>(page: Page, path: string): Promise<T> {
  return await page.evaluate(async (url: string) => {
    const m = document.cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]*)/);
    const xsrf = m ? decodeURIComponent(m[1]) : "";
    const headers: Record<string, string> = { Accept: "application/json" };
    if (xsrf) headers["X-XSRF-TOKEN"] = xsrf;
    const r = await fetch(url, { credentials: "include", headers });
    if (!r.ok) throw new Error(`API GET ${url} → ${r.status}`);
    return r.json();
  }, `${API_BASE}/${path}`);
}

async function apiPost<T>(page: Page, path: string, body: unknown = {}): Promise<T> {
  return await page.evaluate(async (url: string, bodyStr: string) => {
    const m = document.cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]*)/);
    const xsrf = m ? decodeURIComponent(m[1]) : "";
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (xsrf) headers["X-XSRF-TOKEN"] = xsrf;
    const r = await fetch(url, { method: "POST", credentials: "include", headers, body: bodyStr });
    if (!r.ok) throw new Error(`API POST ${url} → ${r.status}`);
    return r.json();
  }, `${API_BASE}/${path}`, JSON.stringify(body));
}

// ─── Empresa API helpers ──────────────────────────────────────────

async function apiGetEmpresa<T>(page: Page, path: string): Promise<T> {
  return await page.evaluate(async (url: string) => {
    const m = document.cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]*)/);
    const xsrf = m ? decodeURIComponent(m[1]) : "";
    const headers: Record<string, string> = { Accept: "application/json" };
    if (xsrf) headers["X-XSRF-TOKEN"] = xsrf;
    const r = await fetch(url, { credentials: "include", headers });
    if (!r.ok) throw new Error(`API GET ${url} → ${r.status}`);
    return r.json();
  }, `${EMPRESA_API_BASE}/${path}`);
}

async function apiPostEmpresa<T>(page: Page, path: string, body: unknown = {}): Promise<T> {
  return await page.evaluate(async (url: string, bodyStr: string) => {
    const m = document.cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]*)/);
    const xsrf = m ? decodeURIComponent(m[1]) : "";
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (xsrf) headers["X-XSRF-TOKEN"] = xsrf;
    const r = await fetch(url, { method: "POST", credentials: "include", headers, body: bodyStr });
    if (!r.ok) throw new Error(`API POST ${url} → ${r.status}`);
    return r.json();
  }, `${EMPRESA_API_BASE}/${path}`, JSON.stringify(body));
}

// ─── API response types ───────────────────────────────────────────

interface ApiAccountBalance {
  codProducto: string;
  tipo: string;
  numero: string;
  disponible: number;
  cupo: number;
  moneda: string;
  descripcion: string;
}

interface ApiProduct {
  id: string;
  numero: string;
  mascara: string;
  codigo: string;
  codigoMoneda: string;
  label: string;
  tipo: string;
  claseCuenta: string;
  tarjetaHabiente: string | null;
  descripcionLogo: string;
  tipoCliente: string;
}

interface ApiCardInfo {
  titular: boolean;
  marca: string;
  tipo: string;
  idProducto: string;
  numero: string;
}

interface ApiCardSaldo {
  cupoTotalNacional: number;
  cupoUtilizadoNacional: number;
  cupoDisponibleNacional: number;
  cupoTotalInternacional: number;
  cupoUtilizadoInternacional: number;
  cupoDisponibleInternacional: number;
}

interface ApiMovNoFactur {
  origenTransaccion: string;
  fechaTransaccionString: string;
  montoCompra: number;
  glosaTransaccion: string;
  despliegueCuotas: string;
}

interface ApiFechaFacturacion {
  fechaFacturacion: string;
  existeEstadoCuentaNacional: string;
  existeEstadoCuentaInternacional: string;
}

interface ApiTransaccionFacturada {
  fechaTransaccionString: string;
  montoTransaccion: number;
  descripcion: string;
  cuotas: string;
  grupo: string;
}

// ─── API-based data extraction ────────────────────────────────────

const MONTH_NAMES = ["", "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];

interface ApiClientData {
  datosCliente: { rut: string; nombres: string; apellidoPaterno: string; apellidoMaterno: string };
}

interface ApiProductsResponse {
  rut: string;
  nombre: string;
  productos: ApiProduct[];
}

type ApiResumenResponse = {
  existeEstadoCuenta: boolean;
  seccionOperaciones?: {
    transaccionesTarjetas: ApiTransaccionFacturada[];
  };
};

function buildBaseCardBody(card: ApiCardInfo, nombreTitular: string) {
  const mascara = card.numero.replace(/\*/g, "").length <= 4
    ? `****${card.numero.slice(-4)}`
    : card.numero;
  return {
    idTarjeta: card.idProducto,
    codigoProducto: "TNM",
    tipoTarjeta: `${card.marca} ${card.tipo}`.trim(),
    mascara,
    nombreTitular,
  };
}

function buildCardBody(card: ApiCardInfo, nombreTitular: string) {
  return { ...buildBaseCardBody(card, nombreTitular), tipoCliente: "T" as const };
}

interface ApiCartolaMov {
  descripcion: string;
  monto: number;
  saldo: number;
  tipo: string; // "cargo" | "abono"
  fechaContable: string;
}

// ─── Empresa API types ─────────────────────────────────────────────

interface ApiEmpresa {
  rutEmpresa: string;
  nombreFantasia: string;
  razonSocial: string;
  seleccionada: boolean;
  favorita: boolean;
}

interface EmpresaCuentaSeleccionada {
  nombreEmpresa: string;
  rutEmpresa: string;
  numero: string;
  mascara: string;
  alias: string | null;
  selected: boolean;
  codigoProducto: string;
  claseCuenta: string;
  moneda: string;
}

interface ApiEmpresaCartolaMov {
  descripcion: string;
  monto: string;
  saldo: string;
  tipo: string;
  fechaContable: string;
  fecha: string;
}

interface ApiEmpresaCartolaResponse {
  saldoDisponible: number;
  saldoContable: number;
  saldoInicial: number;
  saldoFinal: number;
  movimientos: ApiEmpresaCartolaMov[];
  moneda: string;
  glosaMoneda: string;
  cantidadMovimientos: number;
}

type ApiCartolaResponse = {
  movimientos: ApiCartolaMov[];
  pagina: Array<{ totalRegistros: number; masPaginas: boolean }>;
};

function cartolaMovToMovement(mov: ApiCartolaMov): BankMovement {
  return {
    date: normalizeDate(mov.fechaContable),
    description: mov.descripcion.trim(),
    amount: mov.tipo === "cargo" ? -Math.abs(mov.monto) : Math.abs(mov.monto),
    balance: mov.saldo,
    source: MOVEMENT_SOURCE.account,
  };
}

function facturadoToMovement(tx: ApiTransaccionFacturada, source: MovementSource): BankMovement {
  return {
    date: normalizeDate(tx.fechaTransaccionString),
    description: tx.descripcion.trim(),
    amount: tx.grupo === "pagos" ? Math.abs(tx.montoTransaccion) : -Math.abs(tx.montoTransaccion),
    balance: 0,
    source,
    installments: normalizeInstallments(tx.cuotas),
  };
}

const MAX_PAGES = 25;

// ─── Empresa: obtener empresas y validar selección ──────────────────

async function getEmpresas(page: Page): Promise<ApiEmpresa[]> {
  return await apiGetEmpresa<ApiEmpresa[]>(page, "herramientas-colaborativas/header/empresas/");
}

function normalizeRutForCompare(rut: string): string {
  return rut.replace(/[.\s\-]/g, "").toLowerCase();
}

function empresaMatchesRut(empresa: ApiEmpresa, rutQuery: string): boolean {
  return normalizeRutForCompare(empresa.rutEmpresa) === normalizeRutForCompare(rutQuery);
}

/** Valida que la empresa exista. Retorna la empresa (seleccionada o no). */
function findEmpresaByQuery(
  empresas: ApiEmpresa[],
  companyRut: string,
  debugLog: string[]
): { ok: boolean; empresa?: ApiEmpresa; error?: string } {
  const empresa = empresas.find((e) => empresaMatchesRut(e, companyRut));
  if (!empresa) {
    return {
      ok: false,
      error: `Empresa RUT ${companyRut} no encontrada en el listado. Empresas disponibles: ${empresas.map((e) => e.rutEmpresa).join(", ")}`,
    };
  }
  return { ok: true, empresa };
}

/** Cambia la empresa seleccionada vía API actualizar y recarga la página. */
async function cambiarEmpresaSeleccionada(
  page: Page,
  empresas: ApiEmpresa[],
  targetRut: string,
  debugLog: string[]
): Promise<boolean> {
  const empresasBody: Record<string, boolean> = {};
  for (const e of empresas) {
    empresasBody[e.rutEmpresa] = normalizeRutForCompare(e.rutEmpresa) === normalizeRutForCompare(targetRut);
  }

  try {
    await apiPostEmpresa(page, "herramientas-colaborativas/header/empresas/actualizar", {
      empresas: empresasBody,
    });
    debugLog.push(`  Empresa cambiada a ${targetRut} vía API actualizar`);
    await page.reload({ waitUntil: "networkidle2", timeout: 15000 });
    await delay(2000);
    return true;
  } catch (err) {
    debugLog.push(`  Error al cambiar empresa: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// ─── Empresa: obtener cuentas y cartola ─────────────────────────────

/** Intenta obtener las cuentas de la empresa seleccionada desde el dashboard. */
async function getEmpresaCuentas(
  page: Page,
  empresa: ApiEmpresa,
  debugLog: string[]
): Promise<EmpresaCuentaSeleccionada[]> {
  // Navegar al dashboard para cargar contexto
  await page.goto(EMPRESA_DASHBOARD_URL, { waitUntil: "networkidle2", timeout: 30000 });
  await delay(5000);

  // Intentar endpoint de productos/cuentas (patrón similar a personas)
  const endpoints = [
    "selectorproductos/selectorProductos/obtenerProductos",
    "selectorproductos/obtenerProductos",
    "cuentas/productos",
    "productos/cuentas",
  ];

  for (const ep of endpoints) {
    try {
      const data = await apiGetEmpresa<unknown>(page, ep);
      if (data && typeof data === "object") {
        const parsed = data as {
          productos?: Array<Record<string, unknown>>;
          cuentas?: Array<Record<string, unknown>>;
          cuentasSeleccionadas?: Array<Record<string, unknown>>;
        };
        const items =
          parsed.cuentasSeleccionadas ??
          parsed.productos ??
          parsed.cuentas ??
          (Array.isArray(data) ? data : []);
        if (Array.isArray(items) && items.length > 0) {
          const cuentas = items
            .filter(
              (p: Record<string, unknown>) =>
                p.codigoProducto || p.claseCuenta || p.numero || p.numeroCuenta || p.tipo === "cuenta"
            )
            .map((p: Record<string, unknown>) => {
              const num = String(p.numero ?? p.numeroCuenta ?? "").replace(/\D/g, "");
              const numStr = num || String(p.numero ?? p.numeroCuenta ?? "");
              return {
                nombreEmpresa: String(p.nombreEmpresa ?? empresa.nombreFantasia),
                rutEmpresa: String(p.rutEmpresa ?? empresa.rutEmpresa),
                numero: numStr || num,
                mascara: String(p.mascara ?? (numStr ? `****${numStr.slice(-4)}` : "****")),
                alias: (p.alias as string) ?? null,
                selected: true,
                codigoProducto: String(p.codigoProducto ?? p.codigo ?? "JUV"),
                claseCuenta: String(p.claseCuenta ?? "CVIEMP"),
                moneda: String(p.moneda ?? p.codigoMoneda ?? "CLP"),
              };
            })
            .filter((c) => c.numero);
          if (cuentas.length > 0) {
            debugLog.push(`  Cuentas obtenidas desde ${ep}: ${cuentas.length}`);
            return cuentas;
          }
        }
      }
    } catch {
      // Siguiente endpoint
    }
  }

  // Fallback: extraer del DOM (widget de saldo en dashboard)
  try {
    const cuentasFromDom = await page.evaluate((emp: { nombreFantasia: string; rutEmpresa: string }) => {
      const saldoEl = document.querySelector('[aria-label*="Saldo de cuenta"]');
      if (!saldoEl) return null;
      const aria = (saldoEl as HTMLElement).getAttribute("aria-label") || "";
      const match = aria.match(/Saldo de cuenta es de:\s*(\d+)/);
      if (!match) return null;
      const saldo = match[1];
      const container = saldoEl.closest("[data-cuenta], [data-numero], .cuenta, .account") || saldoEl.parentElement;
      let numero = "";
      const dataNumero = container?.querySelector("[data-numero]")?.getAttribute("data-numero");
      const dataCuenta = container?.getAttribute("data-cuenta");
      if (dataNumero) numero = dataNumero;
      else if (dataCuenta) numero = dataCuenta;
      if (!numero) {
        const nums = document.body.innerText.match(/\b\d{10,12}\b/g);
        if (nums && nums[0]) numero = nums[0].replace(/\D/g, "").slice(-9) || nums[0];
      }
      if (!numero) return null;
      return [{
        nombreEmpresa: emp.nombreFantasia,
        rutEmpresa: emp.rutEmpresa,
        numero,
        mascara: `****${numero.slice(-4)}`,
        alias: null,
        selected: true,
        codigoProducto: "JUV",
        claseCuenta: "CVIEMP",
        moneda: "CLP",
      }];
    }, empresa);
    if (cuentasFromDom && cuentasFromDom.length > 0) {
      debugLog.push("  Cuentas extraídas del DOM del dashboard");
      return cuentasFromDom;
    }
  } catch {
    // ignore
  }

  debugLog.push("  No se pudieron obtener cuentas. Use --screenshots y revise la pestaña Network para el endpoint de cuentas.");
  return [];
}

function empresaCartolaMovToMovement(mov: ApiEmpresaCartolaMov, tag: string): BankMovement {
  const monto = parseFloat(mov.monto) || 0;
  const saldo = parseFloat(mov.saldo) || 0;
  return {
    date: normalizeDate(mov.fechaContable || mov.fecha),
    description: `${tag} ${mov.descripcion}`.trim(),
    amount: mov.tipo === "cargo" ? -Math.abs(monto) : Math.abs(monto),
    balance: saldo,
    source: MOVEMENT_SOURCE.account,
  };
}

async function fetchEmpresaCartola(
  page: Page,
  cuentas: EmpresaCuentaSeleccionada[],
  debugLog: string[]
): Promise<{ movements: BankMovement[]; balance?: number }> {
  const movements: BankMovement[] = [];
  let balance: number | undefined;

  // Navegar a la página de movimientos para cargar el contexto del microfrontend
  await page.goto(EMPRESA_MOVIMIENTOS_URL, { waitUntil: "networkidle2", timeout: 30000 });
  await delay(3000);

  for (const cuenta of cuentas) {
    const tag = `[${cuenta.nombreEmpresa} ${cuenta.mascara}]`;
    debugLog.push(`  Fetching cartola: ${cuenta.nombreEmpresa} ${cuenta.mascara}`);

    const body = {
      cabecera: {
        paginacionDesde: {},
        fechaInicio: null,
        fechaFin: null,
        statusGenerico: true,
        saldoDisponibleAcumuladoAnterior: null,
        saldoDisponibleAcumuladoDelDia: null,
      },
      cuentasSeleccionadas: [{ ...cuenta }],
    };

    try {
      const cartola = await apiPostEmpresa<ApiEmpresaCartolaResponse>(
        page,
        "movimientos/getcartola",
        body
      );

      if (cartola.movimientos && cartola.movimientos.length > 0) {
        for (const mov of cartola.movimientos) {
          movements.push(empresaCartolaMovToMovement(mov, tag));
        }
        debugLog.push(`    → ${cartola.movimientos.length} movimientos`);
      }

      if (balance === undefined && cartola.saldoDisponible != null) {
        balance = cartola.saldoDisponible;
      }
    } catch (err) {
      debugLog.push(`    → Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { movements, balance };
}

async function fetchAccountMovements(
  page: Page,
  products: ApiProduct[],
  fullName: string,
  rut: string,
  debugLog: string[],
): Promise<{ movements: BankMovement[]; balance?: number }> {
  const accounts = products.filter(p =>
    p.tipo === "cuenta" || p.tipo === "cuentaCorrienteMonedaLocal"
  );

  // Deduplicate by numero (CTD appears twice with different tipo)
  const seenNums = new Set<string>();
  const uniqueAccounts = accounts.filter(a => {
    if (seenNums.has(a.numero)) return false;
    seenNums.add(a.numero);
    return true;
  });

  if (uniqueAccounts.length === 0) return { movements: [], balance: undefined };

  // Navigate to movements page to load the microfrontend
  const baseUrl = page.url().split("#")[0];
  await page.goto(`${baseUrl}#/movimientos/cuenta/saldos-movimientos`, { waitUntil: "networkidle2", timeout: 30000 });
  await delay(5000);

  const movements: BankMovement[] = [];
  let balance: number | undefined;

  for (const acct of uniqueAccounts) {
    debugLog.push(`  Fetching movements for ${acct.descripcionLogo} ${acct.mascara} (${acct.codigoMoneda})`);

    const cuentaSeleccionada = {
      nombreCliente: fullName,
      rutCliente: rut,
      numero: acct.numero,
      mascara: acct.mascara,
      selected: true,
      codigoProducto: acct.codigo,
      claseCuenta: acct.claseCuenta,
      moneda: acct.codigoMoneda,
    };

    try {
      // Must call getConfigConsultaMovimientos first to establish session context
      await apiPost(page, "movimientos/getConfigConsultaMovimientos", {
        cuentasSeleccionadas: [cuentaSeleccionada],
      });

      const cartola = await apiPost<ApiCartolaResponse>(
        page, "bff-pper-prd-cta-movimientos/movimientos/getCartola",
        { cuentaSeleccionada, cabecera: { statusGenerico: true, paginacionDesde: 1 } },
      );

      if (cartola.movimientos) {
        const tag = `[${acct.descripcionLogo} ${acct.mascara}]`;
        for (const mov of cartola.movimientos) {
          movements.push(cartolaMovToMovement(mov));
        }

        if (balance === undefined && acct.codigoMoneda === "CLP" && cartola.movimientos.length > 0) {
          balance = cartola.movimientos[0].saldo;
        }

        const pageSize = cartola.movimientos.length;
        debugLog.push(`    → ${pageSize} movements`);

        // paginacionDesde is a 1-based record offset, not a page number
        let hasMore = pageSize > 0 && (cartola.pagina?.[0]?.masPaginas ?? false);
        let offset = 1 + pageSize;
        for (let p = 2; hasMore && p <= MAX_PAGES; p++) {
          try {
            const nextPage = await apiPost<ApiCartolaResponse>(
              page, "bff-pper-prd-cta-movimientos/movimientos/getCartola",
              { cuentaSeleccionada, cabecera: { statusGenerico: true, paginacionDesde: offset } },
            );

            const count = nextPage.movimientos?.length ?? 0;
            if (count === 0) break;

            for (const mov of nextPage.movimientos) {
              movements.push(cartolaMovToMovement(mov));
            }
            debugLog.push(`    → offset ${offset}: ${count} movements`);

            offset += count;
            hasMore = nextPage.pagina?.[0]?.masPaginas ?? false;
          } catch {
            hasMore = false;
          }
        }
      }
    } catch (err) {
      debugLog.push(`    → Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { movements, balance };
}

async function fetchResumenMovements(
  page: Page,
  endpoint: "nacional" | "internacional",
  resumenBody: Record<string, unknown>,
  tag: string,
): Promise<BankMovement[]> {
  const movements: BankMovement[] = [];
  const resumen = await apiPost<ApiResumenResponse>(
    page, `tarjetas/estadocuenta/${endpoint}/resumen-por-fecha`, resumenBody,
  );

  if (resumen.existeEstadoCuenta && resumen.seccionOperaciones?.transaccionesTarjetas) {
    for (const tx of resumen.seccionOperaciones.transaccionesTarjetas ?? []) {
      if (tx.grupo === "totales") continue;
      movements.push(facturadoToMovement(tx, MOVEMENT_SOURCE.credit_card_billed));
    }
  }
  return movements;
}

async function fetchCreditCardData(
  page: Page,
  fullName: string,
  debugLog: string[],
): Promise<{ movements: BankMovement[]; creditCards: CreditCardBalance[] }> {
  const movements: BankMovement[] = [];
  const creditCards: CreditCardBalance[] = [];

  // Get card list
  let cards: ApiCardInfo[];
  try {
    cards = await apiPost<ApiCardInfo[]>(page, "tarjetas/widget/informacion-tarjetas", {});
  } catch (err) {
    debugLog.push(`  Could not fetch card list: ${err instanceof Error ? err.message : String(err)}`);
    return { movements, creditCards };
  }

  if (cards.length === 0) {
    debugLog.push("  No credit cards found");
    return { movements, creditCards };
  }

  debugLog.push(`  Found ${cards.length} credit card(s)`);

  for (const card of cards) {
    const cardLabel = `${card.marca} ${card.tipo} ${card.numero.slice(-8)}`.trim();
    const tag = `[TC ${cardLabel}]`;
    debugLog.push(`  Processing card: ${cardLabel}`);

    const baseBody = buildBaseCardBody(card, fullName);
    const body = { ...baseBody, tipoCliente: "T" as const };

    // 1 & 2. Get balances and non-billed movements in parallel
    const [saldoResult, noFacturadosResult] = await Promise.allSettled([
      apiPost<ApiCardSaldo>(page, "tarjeta-credito-digital/saldo/obtener-saldo", body),
      apiPost<{
        fechaProximaFacturacionCalendario: string;
        listaMovNoFactur: ApiMovNoFactur[];
      }>(page, "tarjeta-credito-digital/movimientos-no-facturados", body),
    ]);

    // Process balances
    if (saldoResult.status === "fulfilled") {
      const saldo = saldoResult.value;
      creditCards.push({
        label: cardLabel,
        national: {
          used: saldo.cupoUtilizadoNacional,
          available: saldo.cupoDisponibleNacional,
          total: saldo.cupoTotalNacional,
        },
        international: {
          used: saldo.cupoUtilizadoInternacional,
          available: saldo.cupoDisponibleInternacional,
          total: saldo.cupoTotalInternacional,
          currency: "USD",
        },
      });
      debugLog.push(`    Balances: NAC used=$${saldo.cupoUtilizadoNacional}, INT used=$${saldo.cupoUtilizadoInternacional}`);
    } else {
      debugLog.push(`    Could not fetch balances: ${saldoResult.reason}`);
      creditCards.push({ label: cardLabel });
    }

    // Process non-billed movements
    if (noFacturadosResult.status === "fulfilled") {
      const noFacturados = noFacturadosResult.value;
      const ccEntry = creditCards[creditCards.length - 1];
      if (noFacturados.fechaProximaFacturacionCalendario) {
        ccEntry.nextBillingDate = noFacturados.fechaProximaFacturacionCalendario;
      }

      for (const mov of noFacturados.listaMovNoFactur || []) {
        movements.push({
          date: normalizeDate(mov.fechaTransaccionString),
          description: mov.glosaTransaccion.trim(),
          amount: mov.montoCompra < 0 ? Math.abs(mov.montoCompra) : -Math.abs(mov.montoCompra),
          balance: 0,
          source: MOVEMENT_SOURCE.credit_card_unbilled,
          installments: normalizeInstallments(mov.despliegueCuotas),
        });
      }

      debugLog.push(`    No-facturados: ${(noFacturados.listaMovNoFactur || []).length} movements`);
    } else {
      debugLog.push(`    Could not fetch no-facturados: ${noFacturadosResult.reason}`);
    }

    // 3. Get billed movements (facturados) — need fechas-facturacion first
    try {
      const fechasBody = baseBody;

      const fechas = await apiPost<{
        existenEstadosDeCuenta: boolean;
        numeroCuenta: string | null;
        listaNacional: ApiFechaFacturacion[];
        listaInternacional: ApiFechaFacturacion[];
      }>(page, "tarjetas/estadocuenta/fechas-facturacion", fechasBody);

      if (fechas.existenEstadosDeCuenta) {
        const ccEntry = creditCards[creditCards.length - 1];
        if (fechas.listaNacional?.[0]) {
          const parts = fechas.listaNacional[0].fechaFacturacion.split("-");
          if (parts.length >= 2) {
            const monthIdx = parseInt(parts[1], 10);
            ccEntry.billingPeriod = `${MONTH_NAMES[monthIdx] ?? parts[1]} ${parts[0]}`;
          }
        }

        const latestFecha = fechas.listaNacional?.[0]?.fechaFacturacion;
        const numeroCuenta = fechas.numeroCuenta;
        if (latestFecha && numeroCuenta) {
          try {
            const resumenBody = { ...fechasBody, fechaFacturacion: latestFecha, numeroCuenta };

            const [nacMovs, intMovs] = await Promise.allSettled([
              fetchResumenMovements(page, "nacional", resumenBody, tag),
              fetchResumenMovements(page, "internacional", resumenBody, tag),
            ]);

            if (nacMovs.status === "fulfilled") {
              movements.push(...nacMovs.value);
              debugLog.push(`    Facturados NAC: ${nacMovs.value.length} movements`);
            }
            if (intMovs.status === "fulfilled") {
              movements.push(...intMovs.value);
              debugLog.push(`    Facturados INT: ${intMovs.value.length} movements`);
            }
          } catch (err) {
            debugLog.push(`    Could not fetch facturados: ${err instanceof Error ? err.message : String(err)}`);
          }
        } else if (!numeroCuenta) {
          debugLog.push("    No numeroCuenta in fechas-facturacion response (no billing history)");
        }
      }
    } catch (err) {
      debugLog.push(`    Could not fetch fechas-facturacion: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { movements, creditCards };
}

// ─── Scraper Empresa ──────────────────────────────────────────────

async function scrapeEmpresa(
  page: Page,
  rut: string,
  password: string,
  companyRut: string | null,
  debugLog: string[],
  doSave: (page: Page, name: string) => Promise<void>,
  doScreenshots: boolean
): Promise<ScrapeResult> {
  const bank = "bchile";

  const loginResult = await loginEmpresa(page, rut, password, debugLog, doSave);
  if (!loginResult.success) {
    return {
      success: false, bank, movements: [],
      error: loginResult.error, screenshot: loginResult.screenshot, debug: debugLog.join("\n"),
    };
  }

  await closePopups(page);

  debugLog.push("5. Fetching empresas...");
  let empresas: ApiEmpresa[];
  try {
    empresas = await getEmpresas(page);
    debugLog.push(`  Empresas disponibles: ${empresas.length}`);
  } catch (err) {
    const screenshot = await page.screenshot({ encoding: "base64" });
    return {
      success: false, bank, movements: [],
      error: `No se pudo obtener listado de empresas: ${err instanceof Error ? err.message : String(err)}`,
      screenshot: screenshot as string, debug: debugLog.join("\n"),
    };
  }

  let selectedEmpresa: ApiEmpresa;
  if (companyRut) {
    const found = findEmpresaByQuery(empresas, companyRut, debugLog);
    if (!found.ok || !found.empresa) {
      return {
        success: false, bank, movements: [],
        error: found.error, debug: debugLog.join("\n"),
      };
    }
    const targetEmpresa = found.empresa;
    if (!targetEmpresa.seleccionada) {
      debugLog.push(`  Empresa ${targetEmpresa.nombreFantasia} no está seleccionada. Cambiando...`);
      const changed = await cambiarEmpresaSeleccionada(page, empresas, companyRut, debugLog);
      if (!changed) {
        return {
          success: false, bank, movements: [],
          error: `No se pudo cambiar a la empresa ${targetEmpresa.nombreFantasia} (${targetEmpresa.rutEmpresa}).`,
          debug: debugLog.join("\n"),
        };
      }
      empresas = await getEmpresas(page);
      const updated = empresas.find((e) => empresaMatchesRut(e, companyRut));
      selectedEmpresa = updated ?? targetEmpresa;
    } else {
      selectedEmpresa = targetEmpresa;
    }
    debugLog.push(`  Empresa a consultar: ${selectedEmpresa.nombreFantasia} (${selectedEmpresa.rutEmpresa})`);
  } else {
    const sel = empresas.find((e) => e.seleccionada);
    if (!sel) {
      return {
        success: false, bank, movements: [],
        error: "No hay empresa seleccionada. Especifique --companyRut con el RUT de la empresa a consultar.",
        debug: debugLog.join("\n"),
      };
    }
    selectedEmpresa = sel;
    debugLog.push(`  Usando empresa seleccionada: ${selectedEmpresa.nombreFantasia} (${selectedEmpresa.rutEmpresa})`);
  }

  debugLog.push("6. Obteniendo cuentas de la empresa...");
  const cuentas = await getEmpresaCuentas(page, selectedEmpresa, debugLog);
  if (cuentas.length === 0) {
    return {
      success: false, bank, movements: [],
      error: "No se pudieron obtener las cuentas de la empresa. Ejecute con --screenshots y revise la pestaña Network para identificar el endpoint de cuentas.",
      debug: debugLog.join("\n"),
    };
  }

  debugLog.push("7. Fetching cartola (saldo y movimientos)...");
  const { movements, balance } = await fetchEmpresaCartola(page, cuentas, debugLog);
  const deduplicated = deduplicateMovements(movements);

  debugLog.push(`8. Total: ${deduplicated.length} movimientos`);
  await doSave(page, "06-empresa-final");
  const screenshot = doScreenshots ? (await page.screenshot({ encoding: "base64" })) as string : undefined;

  return {
    success: true, bank, movements: deduplicated, balance, screenshot, debug: debugLog.join("\n"),
  };
}

// ─── Acción: listar cuentas (sin movimientos) ─────────────────────

/**
 * Lista las cuentas de la empresa con su saldo actual.
 * Acción: --cuentas (scope business)
 */
async function listarCuentasEmpresa(
  page: Page,
  rut: string,
  password: string,
  companyRut: string | null,
  debugLog: string[],
  doSave: (page: Page, name: string) => Promise<void>
): Promise<ScrapeResult> {
  const bank = "bchile";

  const loginResult = await loginEmpresa(page, rut, password, debugLog, doSave);
  if (!loginResult.success) {
    return {
      success: false, bank, movements: [],
      error: loginResult.error, screenshot: loginResult.screenshot, debug: debugLog.join("\n"),
    };
  }

  await closePopups(page);

  debugLog.push("5. Fetching empresas...");
  let empresas: ApiEmpresa[];
  try {
    empresas = await getEmpresas(page);
    debugLog.push(`  Empresas disponibles: ${empresas.length}`);
  } catch (err) {
    const screenshot = await page.screenshot({ encoding: "base64" });
    return {
      success: false, bank, movements: [],
      error: `No se pudo obtener listado de empresas: ${err instanceof Error ? err.message : String(err)}`,
      screenshot: screenshot as string, debug: debugLog.join("\n"),
    };
  }

  let selectedEmpresa: ApiEmpresa;
  if (companyRut) {
    const found = findEmpresaByQuery(empresas, companyRut, debugLog);
    if (!found.ok || !found.empresa) {
      return { success: false, bank, movements: [], error: found.error, debug: debugLog.join("\n") };
    }
    const targetEmpresa = found.empresa;
    if (!targetEmpresa.seleccionada) {
      const changed = await cambiarEmpresaSeleccionada(page, empresas, companyRut, debugLog);
      if (!changed) {
        return {
          success: false, bank, movements: [],
          error: `No se pudo cambiar a la empresa ${targetEmpresa.nombreFantasia} (${targetEmpresa.rutEmpresa}).`,
          debug: debugLog.join("\n"),
        };
      }
      empresas = await getEmpresas(page);
      selectedEmpresa = empresas.find((e) => empresaMatchesRut(e, companyRut)) ?? targetEmpresa;
    } else {
      selectedEmpresa = targetEmpresa;
    }
  } else {
    const sel = empresas.find((e) => e.seleccionada);
    if (!sel) {
      return {
        success: false, bank, movements: [],
        error: "No hay empresa seleccionada. Especifique --companyRut con el RUT de la empresa a consultar.",
        debug: debugLog.join("\n"),
      };
    }
    selectedEmpresa = sel;
  }

  debugLog.push(`6. Obteniendo cuentas de: ${selectedEmpresa.nombreFantasia} (${selectedEmpresa.rutEmpresa})...`);
  const cuentas = await getEmpresaCuentas(page, selectedEmpresa, debugLog);
  if (cuentas.length === 0) {
    return {
      success: false, bank, movements: [],
      error: "No se pudieron obtener las cuentas de la empresa.",
      debug: debugLog.join("\n"),
    };
  }

  // Obtener saldo por cuenta (endpoint de cartola, solo saldo)
  const cuentasInfo: BankAccountInfo[] = [];
  for (const cuenta of cuentas) {
    const info: BankAccountInfo = {
      empresa: cuenta.nombreEmpresa,
      rutEmpresa: cuenta.rutEmpresa,
      numero: cuenta.numero,
      mascara: cuenta.mascara,
      alias: cuenta.alias ?? undefined,
      codigoProducto: cuenta.codigoProducto,
      claseCuenta: cuenta.claseCuenta,
      moneda: cuenta.moneda,
    };

    try {
      const body = {
        cabecera: {
          paginacionDesde: {}, fechaInicio: null, fechaFin: null,
          statusGenerico: true, saldoDisponibleAcumuladoAnterior: null,
          saldoDisponibleAcumuladoDelDia: null,
        },
        cuentasSeleccionadas: [{ ...cuenta }],
      };
      const cartola = await apiPostEmpresa<ApiEmpresaCartolaResponse>(
        page, "movimientos/getcartola", body
      );
      if (cartola.saldoDisponible != null) {
        info.saldo = cartola.saldoDisponible;
      }
      debugLog.push(`  ${cuenta.mascara}: saldo ${info.saldo != null ? `$${info.saldo.toLocaleString("es-CL")}` : "n/d"}`);
    } catch (err) {
      debugLog.push(`  ${cuenta.mascara}: error al obtener saldo (${err instanceof Error ? err.message : String(err)})`);
    }
    cuentasInfo.push(info);
  }

  await doSave(page, "06-cuentas-listadas");
  const screenshot = await page.screenshot({ encoding: "base64" }) as string;

  return {
    success: true, bank,
    movements: [],
    cuentas: cuentasInfo,
    screenshot, debug: debugLog.join("\n"),
  };
}

// ─── Acción: agregar beneficiario (port de Tickefy) ───────────────

/** Normaliza un RUT a formato NNNNNNNN-DV */
export function normalizeRutBeneficiario(rut: string): string {
  let r = rut.toString().trim();
  let numero = "";
  let dv = "";

  if (r.includes("-")) {
    const partes = r.split("-");
    numero = partes[0].replace(/\./g, "");
    dv = partes[1] || "";
  } else {
    const ultimoChar = r.slice(-1);
    if (isNaN(Number(ultimoChar)) || ultimoChar === "K" || ultimoChar === "k") {
      numero = r.slice(0, -1).replace(/\./g, "");
      dv = ultimoChar.toUpperCase();
    } else {
      const sinPuntos = r.replace(/\./g, "");
      if (sinPuntos.length > 8) {
        numero = sinPuntos.slice(0, -1);
        dv = sinPuntos.slice(-1);
      } else {
        numero = sinPuntos;
      }
    }
  }

  return dv ? `${numero}-${dv.toUpperCase()}` : numero;
}

/**
 * Agrega un beneficiario/cuenta en el portal empresas de Banco de Chile.
 * Port del flujo funcional de Tickefy (agregar-beneficiario.js).
 * Acción: --add-beneficiario (scope business)
 */
async function agregarBeneficiario(
  page: Page,
  rut: string,
  password: string,
  datos: BeneficiarioData,
  debugLog: string[],
  doSave: (page: Page, name: string) => Promise<void>,
  doScreenshots: boolean
): Promise<ScrapeResult> {
  const bank = "bchile";

  const loginResult = await loginEmpresa(page, rut, password, debugLog, doSave);
  if (!loginResult.success) {
    return {
      success: false, bank, movements: [],
      error: loginResult.error, screenshot: loginResult.screenshot, debug: debugLog.join("\n"),
    };
  }

  await closePopups(page);

  // Navegar directo al formulario de agregar beneficiario
  debugLog.push("5. Navegando al formulario de agregar beneficiario...");
  const formUrl = "https://portalempresas.bancochile.cl/mibancochile-web/front/empresa/index.html#/portal/tefTransferencias/agenda/agregarBeneficiario";
  try {
    await page.goto(formUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
  } catch {
    // SPA — continuar
  }
  await delay(3000);

  // Esperar campos del formulario
  debugLog.push("6. Esperando formulario...");
  try {
    await Promise.all([
      page.waitForSelector('[name="rutBeneficiario"]', { visible: true, timeout: 15000 }),
      page.waitForSelector('input[placeholder*="Empresa de Construcci"], input[placeholder*="Nombres"]', { visible: true, timeout: 15000 }),
    ]);
  } catch (err) {
    const screenshot = await page.screenshot({ encoding: "base64" });
    return {
      success: false, bank, movements: [],
      error: `No se encontró el formulario de agregar beneficiario: ${err instanceof Error ? err.message : String(err)}`,
      screenshot: screenshot as string, debug: debugLog.join("\n"),
    };
  }
  await doSave(page, "07-formulario-listos");

  // Llenar RUT del beneficiario
  debugLog.push("7. Llenando RUT del beneficiario...");
  const rutLimpio = normalizeRutBeneficiario(datos.rutBeneficiario);
  try {
    await page.click('[name="rutBeneficiario"]', { clickCount: 3 });
    await page.keyboard.press("Backspace");
    await page.type('[name="rutBeneficiario"]', rutLimpio, { delay: 0 });
  } catch (err) {
    return {
      success: false, bank, movements: [],
      error: `No se pudo ingresar el RUT del beneficiario: ${err instanceof Error ? err.message : String(err)}`,
      debug: debugLog.join("\n"),
    };
  }

  // Llenar nombre del beneficiario (mayúsculas)
  debugLog.push("8. Llenando nombre del beneficiario...");
  const nombreSelector = 'input[placeholder*="Empresa de Construcci"], input[placeholder*="Nombres"]';
  try {
    await page.click(nombreSelector, { clickCount: 3 });
    await page.keyboard.press("Backspace");
    const nombreMayus = datos.nombreBeneficiario.toUpperCase();
    await page.keyboard.press("CapsLock");
    await page.type(nombreSelector, nombreMayus, { delay: 0 });
    await page.keyboard.press("CapsLock");
  } catch (err) {
    return {
      success: false, bank, movements: [],
      error: `No se pudo ingresar el nombre del beneficiario: ${err instanceof Error ? err.message : String(err)}`,
      debug: debugLog.join("\n"),
    };
  }

  // Click fuera para validar
  try {
    await page.keyboard.press("Tab");
  } catch { /* ignore */ }
  await delay(1000);
  await doSave(page, "08-formulario-beneficiario-completo");

  // Verificar errores de validación del RUT/nombre
  const erroresValidacion = await page.evaluate(() => {
    const palabras = ["no es válido", "inválido", "debe ingresar", "debe seleccionar", "formato.*incorrecto", "código.*inválido"];
    const errores: { campo: string; texto: string }[] = [];
    const formGroups = document.querySelectorAll(".form-group, [class*='form-control'], [class*='form-group']");
    formGroups.forEach((fg) => {
      const mensajes = fg.querySelectorAll(".error, .invalid, .text-danger, .alert-danger, .help-block, [class*='error'], [class*='invalid']");
      mensajes.forEach((m) => {
        const el = m as HTMLElement;
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return;
        const texto = (el.textContent || "").trim();
        if (!texto || texto.length > 150) return;
        const lower = texto.toLowerCase();
        const esError = palabras.some((p) => {
          if (p.includes(".*")) return new RegExp(p, "i").test(lower);
          return lower.includes(p);
        });
        if (esError) {
          const label = fg.querySelector("label");
          errores.push({ campo: label ? (label.textContent || "").trim() : "Desconocido", texto });
        }
      });
    });
    return errores;
  });

  if (erroresValidacion.length > 0) {
    const detalle = erroresValidacion.map((e) => `  - ${e.campo}: ${e.texto}`).join("\n");
    const screenshot = await page.screenshot({ encoding: "base64" });
    return {
      success: false, bank, movements: [],
      error: `El formulario tiene errores de validación:\n${detalle}`,
      screenshot: screenshot as string, debug: debugLog.join("\n"),
    };
  }

  // ─── Seleccionar banco del dropdown ───
  debugLog.push("9. Seleccionando banco...");
  const selectoresBanco = [
    '[name="banco"] .ui-select-toggle',
    '[name="banco"] .ui-select-match',
    'input[name="banco"]',
    'select[name="banco"]',
    '.ui-select[name="banco"] .ui-select-toggle',
  ];
  let bancoAbierto = false;
  for (const sel of selectoresBanco) {
    try {
      await page.waitForSelector(sel, { visible: true, timeout: 4000 });
      await page.click(sel);
      bancoAbierto = true;
      debugLog.push(`  Dropdown banco con selector: ${sel}`);
      break;
    } catch { /* siguiente */ }
  }
  if (!bancoAbierto) {
    // Fallback: abrir por posición (primer ui-select-container)
    const abierto = await page.evaluate(() => {
      const selects = document.querySelectorAll(".ui-select-container");
      if (selects.length >= 1) {
        const toggle = selects[0].querySelector(".ui-select-toggle") as HTMLButtonElement | null;
        if (toggle && !toggle.disabled) { toggle.click(); return true; }
      }
      return false;
    });
    if (!abierto) {
      const screenshot = await page.screenshot({ encoding: "base64" });
      return {
        success: false, bank, movements: [],
        error: "No se pudo encontrar el dropdown de banco.",
        screenshot: screenshot as string, debug: debugLog.join("\n"),
      };
    }
  }
  await delay(800);

  // Seleccionar la opción del banco por nombre
  const nombreBancoNorm = datos.banco.toUpperCase().replace(/\s+/g, " ").trim();
  const resultadoBanco = await page.evaluate((bancoNorm) => {
    const opciones = document.querySelectorAll(".ui-select-choices-row");
    let parcial: { link: HTMLElement; texto: string; indice: number }[] = [];
    for (let i = 0; i < opciones.length; i++) {
      const link = opciones[i].querySelector("a");
      if (!link) continue;
      const texto = (link.textContent || "").trim();
      const norm = texto.toUpperCase().replace(/\s+/g, " ").trim();
      if (norm === bancoNorm) {
        (link as HTMLElement).click();
        return { encontrado: true, metodo: "exacto", texto };
      }
      if (norm.includes(bancoNorm) || bancoNorm.includes(norm)) {
        parcial.push({ link: link as HTMLElement, texto, indice: i });
      }
    }
    if (parcial.length > 0) {
      parcial[0].link.click();
      return { encontrado: true, metodo: "parcial", texto: parcial[0].texto };
    }
    const disponibles = Array.from(opciones).map((op, idx) => {
      const link = op.querySelector("a");
      return `[${idx}] "${link ? (link.textContent || "").trim() : "N/A"}"`;
    });
    return { encontrado: false, opcionesDisponibles: disponibles };
  }, nombreBancoNorm);

  if (!resultadoBanco.encontrado) {
    const disponibles = (resultadoBanco.opcionesDisponibles as string[] || []).slice(0, 8).join(", ");
    const screenshot = await page.screenshot({ encoding: "base64" });
    return {
      success: false, bank, movements: [],
      error: `No se encontró el banco "${datos.banco}" en el dropdown. Opciones: ${disponibles}`,
      screenshot: screenshot as string, debug: debugLog.join("\n"),
    };
  }
  debugLog.push(`  Banco seleccionado: ${resultadoBanco.texto} (${resultadoBanco.metodo})`);
  await delay(500);

  // ─── Seleccionar tipo de cuenta (segundo dropdown) ───
  debugLog.push("10. Seleccionando tipo de cuenta...");
  const tipoCuentaAbierto = await page.evaluate(() => {
    const selects = document.querySelectorAll(".ui-select-container");
    if (selects.length >= 2) {
      const toggle = selects[1].querySelector(".ui-select-toggle") as HTMLButtonElement | null;
      if (toggle && !toggle.disabled) { toggle.click(); return true; }
    }
    for (const select of selects) {
      const ul = select.querySelector('ul[repeat*="tipoCtas"], [ng-model*="tipoCtas"]');
      if (ul) {
        const toggle = select.querySelector(".ui-select-toggle") as HTMLButtonElement | null;
        if (toggle && !toggle.disabled) { toggle.click(); return true; }
      }
    }
    return false;
  });
  if (!tipoCuentaAbierto) {
    const screenshot = await page.screenshot({ encoding: "base64" });
    return {
      success: false, bank, movements: [],
      error: "No se pudo encontrar el selector de tipo de cuenta.",
      screenshot: screenshot as string, debug: debugLog.join("\n"),
    };
  }
  await delay(800);

  const tipoNorm = datos.tipoCuenta.toUpperCase().replace(/\s+/g, " ").trim();
  const resultadoTipo = await page.evaluate((tipoNormalizado) => {
    const opciones = document.querySelectorAll(".ui-select-choices-row");
    for (let i = 0; i < opciones.length; i++) {
      const link = opciones[i].querySelector("a");
      if (!link) continue;
      const texto = (link.textContent || "").trim();
      const norm = texto.toUpperCase().replace(/\s+/g, " ").trim();
      if (norm === tipoNormalizado) {
        (link as HTMLElement).click();
        return { encontrado: true, texto };
      }
    }
    for (let i = 0; i < opciones.length; i++) {
      const link = opciones[i].querySelector("a");
      if (!link) continue;
      const texto = (link.textContent || "").trim();
      const norm = texto.toUpperCase().replace(/\s+/g, " ").trim();
      if (norm.includes(tipoNormalizado) || tipoNormalizado.includes(norm)) {
        (link as HTMLElement).click();
        return { encontrado: true, texto, parcial: true };
      }
    }
    return { encontrado: false };
  }, tipoNorm);

  if (!resultadoTipo.encontrado) {
    const screenshot = await page.screenshot({ encoding: "base64" });
    return {
      success: false, bank, movements: [],
      error: `No se encontró el tipo de cuenta "${datos.tipoCuenta}" en el dropdown.`,
      screenshot: screenshot as string, debug: debugLog.join("\n"),
    };
  }
  debugLog.push(`  Tipo de cuenta: ${resultadoTipo.texto}`);
  await delay(500);

  // ─── Ingresar número de cuenta y validar ───
  debugLog.push("11. Ingresando número de cuenta...");
  const validacion: { estado: boolean | null; idTipoCuenta?: number; resuelta: boolean } = {
    estado: null, resuelta: false,
  };

  const onResponse = async (response: import("puppeteer-core").HTTPResponse) => {
    const url = response.url();
    if (url.includes("validarCuenta") || url.includes("cuenta/validar") || url.includes("validar")) {
      try {
        const data = await response.json();
        if (data && typeof data === "object") {
          validacion.estado = (data as { estado?: boolean }).estado ?? null;
          validacion.idTipoCuenta = (data as { idTipoCuenta?: number }).idTipoCuenta;
        }
      } catch { /* ignore */ }
      validacion.resuelta = true;
    }
  };
  page.on("response", onResponse);

  try {
    await page.click('[name="numCta"]', { clickCount: 3 });
    await page.keyboard.press("Backspace");
    await page.type('[name="numCta"]', datos.numeroCuenta, { delay: 0 });
    await page.keyboard.press("Tab");
  } catch (err) {
    page.off("response", onResponse);
    return {
      success: false, bank, movements: [],
      error: `No se pudo ingresar el número de cuenta: ${err instanceof Error ? err.message : String(err)}`,
      debug: debugLog.join("\n"),
    };
  }

  // Esperar validación (máx 8s)
  const deadline = Date.now() + 8000;
  while (!validacion.resuelta && Date.now() < deadline) {
    await delay(500);
  }
  page.off("response", onResponse);
  await delay(1000);

  // Verificar error de cuenta en el DOM
  const errorCuentaDOM = await page.evaluate(() => {
    const errorInvalid = document.querySelector('small.invalid[ng-show*="!cuenta.valido"], small.invalid');
    if (errorInvalid) {
      const style = window.getComputedStyle(errorInvalid);
      if (style.display !== "none" && style.visibility !== "hidden") {
        return (errorInvalid.textContent || "").trim();
      }
    }
    const campo = document.querySelector('[name="numCta"]');
    if (campo && campo.classList.contains("ng-invalid") && !campo.classList.contains("ng-pristine")) {
      return "El número de cuenta no es válido";
    }
    return null;
  });

  if (errorCuentaDOM || validacion.estado === false) {
    const screenshot = await page.screenshot({ encoding: "base64" });
    return {
      success: false, bank, movements: [],
      error: `Número de cuenta inválido: ${errorCuentaDOM || "el servidor rechazó la cuenta"}. Número: ${datos.numeroCuenta}`,
      screenshot: screenshot as string, debug: debugLog.join("\n"),
    };
  }
  debugLog.push(`  Número de cuenta validado: ${datos.numeroCuenta}`);

  // ─── Autorizar con MiPass ───
  debugLog.push("12. Autorizando con Mi Pass...");
  try {
    await page.waitForSelector(".col-md-12 > .authorize-card-item", { visible: true, timeout: 10000 });
    await page.click(".col-md-12 > .authorize-card-item");
  } catch {
    // Puede no requerir autorización — verificar éxito directamente
  }
  await delay(2500);
  await doSave(page, "09-despues-mipass");

  // ─── Buscar mensaje de éxito ───
  const mensajeExito = await page.evaluate(() => {
    const selectores = [
      ".bch-mensaje-empresas",
      '[class*="mensaje"]',
      '[class*="success"]',
      '[class*="exito"]',
      ".alert-success",
    ];
    for (const selector of selectores) {
      const elementos = document.querySelectorAll(selector);
      for (const el of elementos) {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const texto = (el.textContent || "").trim();
        if (!texto || texto.length > 300) continue;
        const lower = texto.toLowerCase();
        if ((lower.includes("beneficiarios agregados exitosamente") ||
             lower.includes("beneficiario agregado exitosamente") ||
             (lower.includes("agregados") && lower.includes("exitosamente")) ||
             (lower.includes("agregado") && lower.includes("exitosamente"))) &&
            !lower.includes("datos del beneficiario") && !lower.includes("datos de la cuenta")) {
          return texto;
        }
      }
    }
    // Buscar en el cuerpo por mensaje de éxito
    const body = document.body ? document.body.innerText : "";
    const m = body.match(/beneficiari\w+ agregad\w+ exitosamente/i);
    return m ? m[0] : null;
  });

  if (!mensajeExito) {
    const screenshot = await page.screenshot({ encoding: "base64" });
    return {
      success: false, bank, movements: [],
      error: "No se detectó confirmación de éxito. Puede requerir aprobación MiPass manual o haber fallado. Revisa el screenshot.",
      screenshot: screenshot as string, debug: debugLog.join("\n"),
    };
  }

  debugLog.push(`13. ✅ ${mensajeExito}`);
  const screenshot = doScreenshots ? (await page.screenshot({ encoding: "base64" })) as string : undefined;

  return {
    success: true, bank, movements: [],
    debug: debugLog.join("\n"), screenshot,
    error: undefined,
  };
}

// ─── Main scraper ────────────────────────────────────────────────

async function scrape(options: ScraperOptions): Promise<ScrapeResult> {
  const { rut, password, chromePath, saveScreenshots: doScreenshots, headful } = options;
  const bank = "bchile";

  // Normalizar scope: si usaron --empresa (deprecated), convertirlo a scope
  let scope = options.scope;
  if (!scope) {
    if (options.empresa) {
      scope = { type: "business", companyRut: options.bankQuery };
    }
  }

  const isEmpresa = scope?.type === "business";

  if (!rut || !password) {
    return { success: false, bank, movements: [], error: "Debes proveer RUT y clave." };
  }

  const executablePath = findChrome(chromePath);
  if (!executablePath) {
    return {
      success: false, bank, movements: [],
      error: "No se encontró Chrome/Chromium. Instala Google Chrome o pasa chromePath en las opciones.\n  Ubuntu/Debian: sudo apt install google-chrome-stable\n  macOS: brew install --cask google-chrome",
    };
  }

  let browser;
  const debugLog: string[] = [];
  const doSave = async (page: Page, name: string) => saveScreenshot(page, name, !!doScreenshots, debugLog);

  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: !headful,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--window-size=1280,900", "--disable-blink-features=AutomationControlled"],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");

    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    // ─── Flujo Empresa ─────────────────────────────────────────────
    if (isEmpresa) {
      // Acción: listar cuentas (--cuentas)
      if (options.action === "listar-cuentas") {
        return await listarCuentasEmpresa(page, rut, password, scope?.companyRut ?? null, debugLog, doSave);
      }
      // Acción: agregar beneficiario (--add-beneficiario)
      if (options.action === "agregar-beneficiario") {
        if (!options.beneficiario) {
          return {
            success: false, bank, movements: [],
            error: "Faltan datos del beneficiario. Usa --beneficiario-rut, --beneficiario-nombre, --beneficiario-banco, --beneficiario-cuenta, --beneficiario-tipo.",
            debug: debugLog.join("\n"),
          };
        }
        return await agregarBeneficiario(page, rut, password, options.beneficiario, debugLog, doSave, !!doScreenshots);
      }
      // Acción por defecto: scrape completo
      return await scrapeEmpresa(page, rut, password, scope?.companyRut ?? null, debugLog, doSave, !!doScreenshots);
    }

    // Acciones no soportadas en personas
    if (options.action === "listar-cuentas" || options.action === "agregar-beneficiario") {
      return {
        success: false, bank, movements: [],
        error: `La acción "${options.action}" solo está disponible para empresas (--scope business).`,
        debug: debugLog.join("\n"),
      };
    }

    // ─── Flujo Personas (existente) ─────────────────────────────────
    // Login (DOM-based — required for auth + 2FA)
    const loginResult = await login(page, rut, password, debugLog, doSave);
    if (!loginResult.success) {
      return { success: false, bank, movements: [], error: loginResult.error, screenshot: loginResult.screenshot, debug: debugLog.join("\n") };
    }

    // Close modal overlay (Banco de Chile shows a promotional modal after login)
    try {
      await page.waitForSelector("#modal_emergente_close, .cdk-overlay-container .btn-no-mas", { timeout: 8000 });
      const modalClosed = await page.evaluate(() => {
        const closeBtn = document.querySelector("#modal_emergente_close") as HTMLElement | null;
        if (closeBtn) { closeBtn.click(); return true; }
        const noMasBtn = document.querySelector(".btn-no-mas") as HTMLElement | null;
        if (noMasBtn) { noMasBtn.click(); return true; }
        return false;
      });
      if (modalClosed) {
        debugLog.push("  Modal overlay closed");
        await delay(1500);
      }
    } catch {
      debugLog.push("  No modal overlay detected (or already closed)");
    }

    await closePopups(page);

    // ── All data extraction via REST API calls ──

    // 1. Get product list and client data (needed by multiple endpoints)
    debugLog.push("5. Fetching products and client data via API...");
    let products: ApiProductsResponse;
    let clientData: ApiClientData;
    try {
      [products, clientData] = await Promise.all([
        apiGet<ApiProductsResponse>(page, "selectorproductos/selectorProductos/obtenerProductos?incluirTarjetas=true"),
        apiGet<ApiClientData>(page, "bff-ppersonas-clientes/clientes/"),
      ]);
      debugLog.push(`  Found ${products.productos.length} products`);
    } catch (err) {
      const screenshot = await page.screenshot({ encoding: "base64" });
      return {
        success: false, bank, movements: [],
        error: `No se pudo obtener datos iniciales: ${err instanceof Error ? err.message : String(err)}`,
        screenshot: screenshot as string, debug: debugLog.join("\n"),
      };
    }

    // 2. Get account balance from saldos endpoint
    let balance: number | undefined;
    try {
      const saldos = await apiGet<ApiAccountBalance[]>(
        page, "bff-pp-prod-ctas-saldos/productos/cuentas/saldos"
      );
      // Collect all CLP account balances
      const clpAccounts = saldos.filter(s => s.moneda === "CLP");
      for (const acct of clpAccounts) {
        const acctType = acct.tipo === "CUENTA_CORRIENTE" ? "Cuenta Corriente"
          : acct.tipo === "CUENTA_VISTA" ? "Cuenta Vista"
          : acct.descripcion || acct.tipo;
        debugLog.push(`  ${acctType} (${acct.numero}): $${acct.disponible?.toLocaleString("es-CL") ?? 0}`);
      }
      // Set primary balance to Cuenta Corriente
      const cc = clpAccounts.find(s => s.tipo === "CUENTA_CORRIENTE");
      if (cc) balance = cc.disponible;
    } catch (err) {
      debugLog.push(`  Could not fetch balances: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 3. Fetch account movements (requires navigation to movements page)
    const fullName = products.nombre
      || `${clientData.datosCliente.nombres} ${clientData.datosCliente.apellidoPaterno}`.trim();

    debugLog.push("6. Fetching account movements via API...");
    const acctResult = await fetchAccountMovements(page, products.productos, fullName, products.rut, debugLog);
    const accountMovements = acctResult.movements;
    if (balance === undefined && acctResult.balance !== undefined) balance = acctResult.balance;
    debugLog.push(`  Total account movements: ${accountMovements.length}`);

    // 4. Fetch credit card data via API
    debugLog.push("7. Fetching credit card data via API...");
    const tcResult = await fetchCreditCardData(page, fullName, debugLog);
    debugLog.push(`  Total TC movements: ${tcResult.movements.length}, cards: ${tcResult.creditCards.length}`);

    // Combine and deduplicate
    const allMovements = [...accountMovements, ...tcResult.movements];
    const deduplicated = deduplicateMovements(allMovements);

    debugLog.push(`8. Total: ${deduplicated.length} unique movements`);

    await doSave(page, "06-final");
    const screenshot = doScreenshots ? await page.screenshot({ encoding: "base64" }) as string : undefined;

    return {
      success: true, bank, movements: deduplicated,
      balance,
      creditCards: tcResult.creditCards.length > 0 ? tcResult.creditCards : undefined,
      screenshot, debug: debugLog.join("\n"),
    };
  } catch (error) {
    return { success: false, bank, movements: [], error: `Error del scraper: ${error instanceof Error ? error.message : String(error)}`, debug: debugLog.join("\n") };
  } finally {
    if (browser) {
      try {
        const pages = await browser.pages();
        if (pages.length > 0) await logout(pages[pages.length - 1], debugLog);
      } catch { /* best effort */ }
      await browser.close().catch(() => {});
    }
  }
}

// ─── Export ───────────────────────────────────────────────────────

const bchile: BankScraper = {
  id: "bchile",
  name: "Banco de Chile",
  url: "https://portalpersonas.bancochile.cl",
  scrape,
};

export default bchile;
