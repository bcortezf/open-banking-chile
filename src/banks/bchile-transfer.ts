import type { Page } from "puppeteer-core";
import type { TransferenciaComprobante, TransferenciaExpressData, TransferenciaResult } from "../types.js";
import { delay } from "../utils.js";

export type TransferShotFn = (page: Page, name: string) => Promise<void>;

export const SESSION_FINALIZADA_ERROR =
  "La sesión del portal fue finalizada. Vuelva a intentar la transferencia.";

export const SISTEMA_ERROR =
  "El portal del banco respondió Error de Sistema (servicio temporalmente no disponible). Reintente más tarde.";

export const INTERMITENCIAS_ERROR =
  "El portal del banco presentó intermitencias y no pudo completar la operación. Reintente más tarde.";

export const EXPRESS_NOT_READY_ERROR =
  "La sección Transferencia Express no quedó lista: no apareció el bloque \"Saldo en Cuenta:\".";

const TEF_SALDO_PATH = "/tef-rest/tef/saldo";
const EXPRESS_READY_TIMEOUT_MS = 60000;
const PORTAL_WATCH_INTERVAL_MS = 1000;

export type PortalBlockerKind = "session_finalizada" | "sistema_error" | "intermitencias";

/** Detecta el modal/texto "Sesión Finalizada" del portal empresas. */
export function isSessionFinalizadaText(raw: string): boolean {
  const t = (raw || "").toLowerCase();
  if (!t) return false;
  if (t.includes("sesión finalizada") || t.includes("sesion finalizada")) return true;
  if (t.includes("la sesión fue finalizada") || t.includes("la sesion fue finalizada")) return true;
  if (t.includes("debe volver a ingresar") && t.includes("reingresar")) return true;
  return false;
}

/**
 * Detecta la página "Error de Sistema" del banco
 * (ej. "Este servicio está temporalmente no disponible... [Error = 500]").
 */
export function isSistemaErrorText(raw: string): boolean {
  const t = (raw || "").toLowerCase();
  if (!t) return false;
  if (t.includes("error de sistema")) return true;
  if (t.includes("temporalmente no disponible") && (t.includes("error = 500") || t.includes("error=500"))) {
    return true;
  }
  if (t.includes("ir a portal empresa") && t.includes("no disponible")) return true;
  return false;
}

/**
 * Detecta la pantalla "Presentamos intermitencias"
 * ("No pudimos completar la operación... IR AL INICIO / REINTENTAR").
 */
export function isIntermitenciasText(raw: string): boolean {
  const t = (raw || "").toLowerCase();
  if (!t) return false;
  if (t.includes("presentamos intermitencias")) return true;
  if (t.includes("intermitencias") && t.includes("no pudimos completar la operación")) return true;
  if (t.includes("intermitencias") && (t.includes("reintentar") || t.includes("ir al inicio"))) return true;
  return false;
}

/**
 * Tras clickear Mi Pass el portal muestra "AUTORIZANDO CON MI PASS"
 * (desafío enviado al teléfono). Re-clickear en ese estado dispara
 * otro POST pagar-express y suele terminar en intermitencias/SSO roto.
 */
export function isMiPassAuthorizingText(raw: string): boolean {
  const t = (raw || "").toLowerCase();
  if (!t) return false;
  if (t.includes("autorizando con mi pass")) return true;
  if (t.includes("autorizando con mipass")) return true;
  // Variante sin espacios raros del DOM
  if (/autorizando\s+con\s+mi\s*pass/i.test(raw || "")) return true;
  return false;
}

export function detectPortalBlockerText(raw: string): PortalBlockerKind | null {
  if (isSessionFinalizadaText(raw)) return "session_finalizada";
  if (isIntermitenciasText(raw)) return "intermitencias";
  if (isSistemaErrorText(raw)) return "sistema_error";
  return null;
}

function blockerErrorMessage(kind: PortalBlockerKind): string {
  if (kind === "sistema_error") return SISTEMA_ERROR;
  if (kind === "intermitencias") return INTERMITENCIAS_ERROR;
  return SESSION_FINALIZADA_ERROR;
}

function blockerScreenshotName(kind: PortalBlockerKind, step: string): string {
  const prefix =
    kind === "sistema_error"
      ? "error-sistema"
      : kind === "intermitencias"
        ? "intermitencias"
        : "sesion-finalizada";
  return `${prefix}-${step}`;
}

/** True si el formulario Express ya muestra el saldo de la cuenta de origen. */
export function pageHasSaldoEnCuentaText(raw: string): boolean {
  return /saldo\s+en\s+cuenta\s*:/i.test(raw || "");
}

export function isTefSaldoUrl(url: string): boolean {
  return (url || "").includes(TEF_SALDO_PATH);
}

/** Errores típicos de Puppeteer cuando Angular navega / recrea el frame. */
export function isTransientNavError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Execution context was destroyed|Target closed|Navigating frame|frame was detached|Cannot find context|Protocol error/i.test(msg);
}

async function safeEvaluate<T>(
  page: Page,
  fn: (...args: never[]) => T | Promise<T>,
  fallback: T,
  arg?: unknown,
): Promise<T> {
  try {
    if (arg !== undefined) {
      return await page.evaluate(fn as (arg: unknown) => T | Promise<T>, arg);
    }
    return await page.evaluate(fn as () => T | Promise<T>);
  } catch (err) {
    if (isTransientNavError(err)) return fallback;
    throw err;
  }
}

async function pageBodyAndModalText(page: Page): Promise<string> {
  return safeEvaluate(
    page,
    () => {
      const body = ((document.body && (document.body.innerText || document.body.textContent)) || "");
      const modal = Array.from(document.querySelectorAll("[role='dialog'], .modal, .cdk-overlay-pane, .swal2-popup, .ui-dialog"))
        .map((el) => (el.textContent || ""))
        .join(" ");
      return `${body}\n${modal}`;
    },
    "",
  );
}

async function pageDetectPortalBlocker(page: Page): Promise<PortalBlockerKind | null> {
  const raw = await pageBodyAndModalText(page);
  return detectPortalBlockerText(raw);
}

async function pageShowsSaldoEnCuenta(page: Page): Promise<boolean> {
  return safeEvaluate(
    page,
    () => {
      const body = (document.body && (document.body.innerText || document.body.textContent)) || "";
      return /saldo\s+en\s+cuenta\s*:/i.test(body);
    },
    false,
  );
}

async function pageShowsExpressShell(page: Page): Promise<boolean> {
  return safeEvaluate(
    page,
    () => {
      const t = (document.body && (document.body.innerText || document.body.textContent)) || "";
      return (
        t.includes("Transferencia Express")
        || t.includes("Datos de la Transferencia")
        || document.querySelectorAll(".ui-select-container").length >= 1
      );
    },
    false,
  );
}

/**
 * Vigilancia continua de bloqueos del portal
 * (Sesión Finalizada / Error de Sistema / Presentamos intermitencias).
 * Puede aparecer en cualquier momento u overlay.
 */
class PortalGuard {
  private blocker: PortalBlockerKind | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastStep = "watch";

  constructor(
    private readonly page: Page,
    private readonly capture: (name: string) => Promise<void>,
    private readonly debugLog: string[],
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      pageDetectPortalBlocker(this.page)
        .then((hit) => {
          if (hit) this.blocker = hit;
        })
        .catch(() => undefined);
    }, PORTAL_WATCH_INTERVAL_MS);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  markStep(step: string): void {
    this.lastStep = step;
  }

  async check(step?: string): Promise<TransferenciaResult | null> {
    if (step) this.lastStep = step;
    try {
      const hit = this.blocker || (await pageDetectPortalBlocker(this.page));
      if (!hit) return null;
      this.blocker = hit;
      this.debugLog.push(`  Bloqueo portal (${hit}) detectado en: ${this.lastStep}`);
      try {
        await this.capture(blockerScreenshotName(hit, this.lastStep));
      } catch {
        // ignore screenshot failures during teardown/nav
      }
      return { success: false, error: blockerErrorMessage(hit) };
    } catch (err) {
      if (isTransientNavError(err)) return null;
      throw err;
    }
  }
}

/** @deprecated alias — prefer PortalGuard */
const SessionGuard = PortalGuard;

async function navigateToExpressForm(
  page: Page,
  guard: SessionGuard,
  progress: (step: string) => void,
  debugLog: string[],
): Promise<TransferenciaResult | null> {
  progress("Navegando al formulario de transferencia express...");

  // Preferir SPA hash (mismo documento) o menú: un page.goto completo a Express
  // a veces cae en contingencia/500 y mata la sesión (fingerprint / WAF).
  const currentUrl = page.url();
  const alreadyInPortal =
    currentUrl.includes("portalempresas.bancochile.cl/mibancochile-web")
    || currentUrl.includes("#/home")
    || currentUrl.includes("#/portal/");

  try {
    if (alreadyInPortal) {
      debugLog.push("  Navegación Express vía hash SPA (sin reload completo)");
      await page.evaluate((hash) => {
        window.location.hash = hash;
      }, "#/portal/tefTransferencias/PreInscribir/Express");
    } else {
      debugLog.push("  Navegación Express vía goto (fuera del portal)");
      await page.goto(TRANSFER_EXPRESS_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    }
  } catch {
    // SPA hash navigation often throws / doesn't settle like a full load
  }

  // La SPA deja pantalla en blanco un momento; no evaluar hasta ver el shell.
  const started = Date.now();
  while (Date.now() - started < 30000) {
    const ended = await guard.check("nav-express");
    if (ended) return ended;
    if (await pageShowsExpressShell(page)) {
      debugLog.push("  Shell Transferencia Express visible");
      return null;
    }
    await delay(400);
  }

  // Fallback: intentar menú UI (más parecido a un humano).
  debugLog.push("  Shell no visible; intentando menú Pagos y Transferencias...");
  try {
    const clicked = await safeEvaluate(
      page,
      () => {
        const items = Array.from(document.querySelectorAll("a, button, span, li"));
        const pagos = items.find((el) => /pagos y transferencias/i.test((el.textContent || "").trim()));
        if (pagos) {
          (pagos as HTMLElement).click();
          return "pagos";
        }
        return null;
      },
      null as string | null,
    );
    if (clicked) {
      await delay(800);
      await safeEvaluate(
        page,
        () => {
          const links = Array.from(document.querySelectorAll("a, button, span"));
          const express = links.find((el) => /transferencia express/i.test((el.textContent || "").trim()));
          if (express) {
            (express as HTMLElement).click();
            return true;
          }
          return false;
        },
        false,
      );
      await delay(1500);
    }
  } catch {
    // ignore menu fallback errors
  }

  const started2 = Date.now();
  while (Date.now() - started2 < 15000) {
    const ended = await guard.check("nav-express-menu");
    if (ended) return ended;
    if (await pageShowsExpressShell(page)) {
      debugLog.push("  Shell Transferencia Express visible (vía menú)");
      return null;
    }
    await delay(400);
  }

  debugLog.push("  Timeout esperando shell de Transferencia Express");
  return { success: false, error: "No cargó la vista Transferencia Express." };
}

async function waitForExpressSaldoReady(
  page: Page,
  guard: SessionGuard,
  progress: (step: string) => void,
  debugLog: string[],
  capture: (name: string) => Promise<void>,
  timeoutMs = EXPRESS_READY_TIMEOUT_MS,
): Promise<TransferenciaResult | null> {
  progress('Esperando bloque "Saldo en Cuenta:" (requests de fondo)...');
  guard.markStep("espera-saldo");
  await capture("espera-saldo-inicio").catch(() => undefined);

  let saldoResponseSeen = false;
  const onResponse = (response: { url: () => string; status: () => number }) => {
    try {
      if (isTefSaldoUrl(response.url()) && response.status() >= 200 && response.status() < 400) {
        saldoResponseSeen = true;
      }
    } catch {
      // ignore
    }
  };
  page.on("response", onResponse);

  const started = Date.now();
  let originKickTried = false;
  let lastShotAt = 0;
  const SHOT_EVERY_MS = 5000;
  try {
    while (Date.now() - started < timeoutMs) {
      try {
        const ended = await guard.check("espera-saldo");
        if (ended) return ended;

        const elapsedSec = Math.floor((Date.now() - started) / 1000);
        if (Date.now() - lastShotAt >= SHOT_EVERY_MS) {
          lastShotAt = Date.now();
          await capture(`espera-saldo-${elapsedSec}s`).catch(() => undefined);
        }

        if (await pageShowsSaldoEnCuenta(page)) {
          debugLog.push(
            `  Express listo: "Saldo en Cuenta:" visible` +
              (saldoResponseSeen ? " (request tef/saldo OK)" : ""),
          );
          return null;
        }

        // Si ya llegó la API, dale un poco más al DOM Angular.
        if (saldoResponseSeen) {
          await delay(800);
          if (await pageShowsSaldoEnCuenta(page)) {
            debugLog.push('  Express listo: "Saldo en Cuenta:" tras response tef/saldo');
            return null;
          }
        }

        // El banco suele disparar tef/saldo al elegir cuenta de origen. Si el skeleton
        // ya está y aún no hay saldo, una sola selección kick-start (sin tocar beneficiario).
        if (!originKickTried && !saldoResponseSeen && Date.now() - started > 8000) {
          const kicked = await safeEvaluate(
            page,
            () => {
              const containers = document.querySelectorAll(".ui-select-container");
              if (containers.length < 2) return false;
              const match = containers[1].querySelector(".ui-select-match") as HTMLElement | null;
              const current = ((match && match.textContent) || "").trim();
              if (current.length > 5 && (current.includes("CUENTA") || current.includes("Saldo") || /\d{2,}/.test(current))) {
                return false;
              }
              if (match) {
                match.scrollIntoView({ block: "center" });
                match.click();
              }
              return true;
            },
            false,
          );
          originKickTried = true;
          if (kicked) {
            debugLog.push("  Kick: abriendo cuenta de origen para disparar tef/saldo");
            await capture("espera-saldo-kick-origen").catch(() => undefined);
            await delay(800);
            await safeEvaluate(
              page,
              () => {
                const options = Array.from(
                  document.querySelectorAll(".ui-select-choices-row > a, .ui-select-choices-row-inner > a"),
                );
                if (options.length > 0) (options[0] as HTMLElement).click();
                return true;
              },
              false,
            );
            await delay(1000);
          }
        }
      } catch (err) {
        if (!isTransientNavError(err)) throw err;
        debugLog.push("  Nav transient durante espera de saldo; reintentando...");
      }

      await delay(500);
    }
  } finally {
    page.off("response", onResponse);
  }

  // Antes de fallar por timeout, si el portal ya muestra Error de Sistema / sesión, reportar eso.
  {
    const blocked = await guard.check("espera-saldo-timeout");
    if (blocked) return blocked;
  }

  debugLog.push(
    `  Timeout esperando "Saldo en Cuenta:" (saldoResponseSeen=${saldoResponseSeen})`,
  );
  return { success: false, error: EXPRESS_NOT_READY_ERROR };
}

export async function dumpDestinatarioDebug(page: Page, debugLog: string[]): Promise<Record<string, unknown>> {
  const dump = await page.evaluate(() => {
    const rows = Array.from(
      document.querySelectorAll("#destinatario .ui-select-choices-row, .ui-select-choices-row"),
    ).map((row) => (row.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean);
    const matchText = ((document.querySelector("#destinatario .ui-select-match") || {}).textContent || "")
      .replace(/\s+/g, " ")
      .trim();
    let angularItems: unknown[] = [];
    try {
      const container = document.getElementById("destinatario");
      const win = window as unknown as { angular?: { element: (el: Element) => { scope: () => Record<string, unknown> } } };
      const selectEl = container?.querySelector(".ui-select-container");
      const selectScope = selectEl && win.angular?.element(selectEl).scope() as { $select?: { items?: unknown[] } } | undefined;
      const items = selectScope?.$select?.items;
      if (Array.isArray(items)) {
        angularItems = items.slice(0, 40);
      }
    } catch {
      // ignore
    }
    return {
      url: location.href,
      matchText,
      containerCount: document.querySelectorAll(".ui-select-container").length,
      rowCount: rows.length,
      rows: rows.slice(0, 40),
      angularItemCount: angularItems.length,
      angularItems,
    };
  });
  debugLog.push(`  Destinatario debug: rows=${dump.rowCount} angularItems=${dump.angularItemCount} match="${dump.matchText}"`);
  if (dump.rows.length) {
    debugLog.push(`  Destinatario rows: ${dump.rows.slice(0, 8).join(" | ")}`);
  }
  return dump;
}

const TRANSFER_EXPRESS_URL =
  "https://portalempresas.bancochile.cl/mibancochile-web/front/empresa/index.html#/portal/tefTransferencias/PreInscribir/Express";

const MIPASS_WAIT_MAX_MS = 5 * 60 * 1000;
const MIPASS_POLL_INTERVAL_MS = 5000;

function normalizeRutStr(r: string): string {
  return (r || "").toString().replace(/['"\s]/g, "").trim().replace(/\./g, "");
}

/**
 * Transferencia express en portal empresas (formulario PreInscribir/Express + Mi Pass).
 * Port del flujo de Tickefy (`banco-session-service.js`).
 * Requiere una Page ya autenticada en el portal empresas.
 */
export async function ejecutarTransferenciaExpress(
  page: Page,
  datos: TransferenciaExpressData,
  debugLog: string[],
  onProgress?: (step: string) => void,
  shot: TransferShotFn = async () => {},
): Promise<TransferenciaResult> {
  let shotIndex = 10;
  const capture = async (name: string) => {
    shotIndex += 1;
    await shot(page, `${String(shotIndex).padStart(2, "0")}-tef-${name}`);
  };
  const progress = (step: string) => {
    debugLog.push(step);
    onProgress?.(step);
  };

  const normalizedRut = normalizeRutStr(datos.rutBeneficiario);
  let accountNum = String(datos.numeroCuenta).replace(/['"\s-]/g, "").replace(/\D/g, "");
  if (accountNum.length < 3) {
    return { success: false, error: `Número de cuenta "${datos.numeroCuenta}" no tiene suficientes dígitos` };
  }
  const lastThreeDigits = accountNum.slice(-3);
  const amountFormatted = String(Math.round(Number(datos.monto))).replace(/[.,]/g, "");
  const bankName = datos.bankName || "";
  const timeoutMs = datos.timeoutMs ?? MIPASS_WAIT_MAX_MS;

  const guard = new SessionGuard(page, capture, debugLog);
  guard.start();

  try {
  {
    const navFailed = await navigateToExpressForm(page, guard, progress, debugLog);
    if (navFailed) {
      await capture("express-shell-no-cargo").catch(() => undefined);
      return navFailed;
    }
  }
  debugLog.push(`  Destino TEF ***${lastThreeDigits}`);
  {
    const ended = await guard.check("post-nav");
    if (ended) return ended;
  }

  // No interactuar hasta que la vista Express esté usable (bloque Saldo en Cuenta: / tef/saldo).
  {
    const notReady = await waitForExpressSaldoReady(page, guard, progress, debugLog, capture);
    if (notReady) {
      await capture("express-sin-saldo-en-cuenta").catch(() => undefined);
      return notReady;
    }
  }
  await capture("formulario-listo-con-saldo").catch(() => undefined);

  // Si por alguna razón aún no hay cuenta de origen seleccionada, elegir la primera.
  const originSelected = await page.evaluate(() => {
    const containers = document.querySelectorAll(".ui-select-container");
    const match = containers[1] && containers[1].querySelector(".ui-select-match");
    const text = ((match && match.textContent) || "").trim();
    return text.length > 5 && (text.includes("CUENTA") || text.includes("Saldo") || /\d{2,}/.test(text));
  });
  if (!originSelected) {
    progress("Seleccionando cuenta de origen...");
    await page.evaluate(() => {
      const containers = document.querySelectorAll(".ui-select-container");
      const match = containers[1] && containers[1].querySelector(".ui-select-match");
      if (match) {
        (match as HTMLElement).scrollIntoView({ block: "center" });
        (match as HTMLElement).click();
      }
    });
    await delay(1000);
    {
      const ended = await guard.check("cuenta-origen-dropdown");
      if (ended) return ended;
    }
    await page.evaluate(() => {
      const options = Array.from(document.querySelectorAll(".ui-select-choices-row > a, .ui-select-choices-row-inner > a"));
      if (options.length > 0) (options[0] as HTMLElement).click();
    });
    await delay(500);
    // Tras elegir origen, el banco vuelve a pedir saldo.
    {
      const notReady = await waitForExpressSaldoReady(page, guard, progress, debugLog, capture, 30000);
      if (notReady) {
        await capture("express-sin-saldo-post-origen");
        return notReady;
      }
    }
    await capture("cuenta-origen-seleccionada");
  } else {
    await capture("cuenta-origen-preseleccionada");
  }
  {
    const ended = await guard.check("cuenta-origen");
    if (ended) return ended;
  }

  progress("Seleccionando beneficiario...");
  await delay(600);
  {
    const ended = await guard.check("pre-beneficiario");
    if (ended) return ended;
  }

  const angularSelected = await page.evaluate((normRut: string, last3: string, bankFilter: string) => {
    const container = document.getElementById("destinatario");
    if (!container) return { success: false, reason: "no-container" };
    const win = window as unknown as { angular?: { element: (el: Element) => { scope: () => Record<string, unknown> } } };
    const scope = win.angular && win.angular.element(container).scope();
    if (!scope) return { success: false, reason: "no-angular-scope" };
    const selectEl = container.querySelector(".ui-select-container");
    const selectScope = selectEl && win.angular?.element(selectEl).scope();
    const $select = selectScope && (selectScope as { $select?: { items?: unknown[]; select: (item: unknown) => void } }).$select;
    if (!$select || !$select.items || $select.items.length === 0) return { success: false, reason: "no-items" };

    const items = $select.items;
    const rutClean = normRut.replace(/-/g, "").toLowerCase();
    let match: unknown = null;

    for (const item of items) {
      const s = JSON.stringify(item).toLowerCase();
      const rutOk = s.includes(rutClean) || s.includes(normRut.toLowerCase());
      const acctOk = s.includes(last3);
      const bankOk = !bankFilter || s.includes(bankFilter.toLowerCase());
      if (rutOk && acctOk && bankOk) {
        match = item;
        break;
      }
    }
    if (!match && bankFilter) {
      for (const item of items) {
        const s = JSON.stringify(item).toLowerCase();
        if ((s.includes(rutClean) || s.includes(normRut.toLowerCase())) && s.includes(last3)) {
          match = item;
          break;
        }
      }
    }
    if (!match) {
      const rutMatches = items.filter((i) => JSON.stringify(i).toLowerCase().includes(rutClean));
      if (rutMatches.length === 1) match = rutMatches[0];
    }
    if (!match) return { success: false, reason: "no-match", itemCount: items.length };

    $select.select(match);
    const apply = (scope as { $apply?: () => void }).$apply;
    apply?.();
    return { success: true };
  }, normalizedRut, lastThreeDigits, bankName);

  let beneficiaryFound = angularSelected.success;
  debugLog.push(`  Angular destinatario: ${angularSelected.success ? "ok" : angularSelected.reason}${angularSelected.itemCount != null ? ` (${angularSelected.itemCount} items)` : ""}`);
  await capture(beneficiaryFound ? "beneficiario-angular-ok" : `beneficiario-angular-${angularSelected.reason || "fail"}`);
  if (!beneficiaryFound) {
    progress(`Angular scope: ${angularSelected.reason}. Intentando vía DOM...`);
    const matchEl = await page.$("#destinatario .ui-select-match, #destinatario [aria-label='Select box activate']");
    if (matchEl) {
      await matchEl.evaluate((n) => (n as HTMLElement).scrollIntoView({ block: "center" }));
      await delay(300);
      const box = await matchEl.boundingBox();
      if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      else await matchEl.click().catch(() => undefined);
    } else {
      const containers = await page.$$(".ui-select-container");
      if (containers.length >= 3) {
        const box = await containers[2].boundingBox();
        if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      }
    }
    await delay(1500);

    const inputSels = ["#destinatario input.ui-select-search", ".ui-select-container.open input.ui-select-search"];
    for (const sel of inputSels) {
      const inputEl = await page.$(sel);
      if (inputEl) {
        const inputBox = await inputEl.boundingBox();
        if (inputBox && inputBox.height > 0) {
          await page.mouse.click(inputBox.x + inputBox.width / 2, inputBox.y + inputBox.height / 2);
          await delay(200);
          await page.keyboard.type(normalizedRut, { delay: 80 });
          break;
        }
      }
    }
    await delay(1500);
    await capture("beneficiario-dropdown-abierto");

    beneficiaryFound = await page.evaluate((normRut: string, last3: string, bankFilter: string) => {
      const stripAll = (s: string) => (s || "").replace(/[.\-\s]/g, "").toLowerCase();
      const rutDigits = stripAll(normRut);
      const rows = Array.from(document.querySelectorAll("#destinatario .ui-select-choices-row, .ui-select-choices-row"));
      const matchRow = (row: Element, checkAcct: boolean, checkBank: boolean) => {
        const link = row.querySelector("a.ui-select-choices-row-inner") || row.querySelector("a");
        if (!link) return false;
        const t = row.textContent || "";
        if (!stripAll(t).includes(rutDigits)) return false;
        if (checkAcct && !t.includes(last3)) return false;
        if (checkBank && bankFilter && !t.toLowerCase().includes(bankFilter.toLowerCase())) return false;
        (link as HTMLElement).click();
        return true;
      };
      if (bankFilter) {
        for (const r of rows) {
          if (matchRow(r, true, true)) return true;
        }
      }
      for (const r of rows) {
        if (matchRow(r, true, false)) return true;
      }
      const rutRows = rows.filter((r) => stripAll(r.textContent || "").includes(rutDigits));
      if (rutRows.length === 1) {
        const link = rutRows[0].querySelector("a.ui-select-choices-row-inner") || rutRows[0].querySelector("a");
        if (link) {
          (link as HTMLElement).click();
          return true;
        }
      }
      return false;
    }, normalizedRut, lastThreeDigits, bankName);
  }

  if (!beneficiaryFound) {
    {
      const ended = await guard.check("beneficiario");
      if (ended) return ended;
    }
    await dumpDestinatarioDebug(page, debugLog);
    await capture("beneficiario-no-encontrado");
    return {
      success: false,
      error: `No se encontró el beneficiario con RUT ${datos.rutBeneficiario} y cuenta ***${lastThreeDigits}. Agréguelo en la agenda del banco.`,
    };
  }
  await capture("beneficiario-seleccionado");
  await delay(1000);

  progress("Ingresando monto...");
  {
    const ended = await guard.check("pre-monto");
    if (ended) return ended;
  }
  const montoInput = await page.$("#monto");
  if (!montoInput) {
    await capture("sin-campo-monto");
    return { success: false, error: "No se encontró el campo de monto (#monto)" };
  }
  await montoInput.click();
  await page.evaluate(() => {
    const i = document.querySelector("#monto") as HTMLInputElement | null;
    if (i) i.value = "";
  });
  await page.type("#monto", amountFormatted, { delay: 50 });
  await delay(500);

  await page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll("label, span, div"));
    for (const el of labels) {
      const t = (el.textContent || "").toLowerCase().trim();
      if (t.includes("enviar comprobante") && t.includes("mail") && t.length < 120) {
        (el as HTMLElement).click();
        return;
      }
    }
  });
  await delay(300);
  await capture("monto-ingresado");

  progress("Enviando transferencia...");
  const transferClicked = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll("button, .btn, a"));
    for (const btn of buttons) {
      const t = (btn.textContent || "").trim().toLowerCase();
      if (t === "transferir" || t === "continuar" || t === "siguiente") {
        (btn as HTMLElement).scrollIntoView({ block: "center" });
        (btn as HTMLElement).click();
        return true;
      }
    }
    return false;
  });
  if (!transferClicked) {
    await capture("sin-boton-transferir");
    return { success: false, error: "No se encontró el botón TRANSFERIR" };
  }
  // Tras TRANSFERIR el portal hace requests; a veces responde con intermitencias.
  await delay(2500);
  await capture("despues-click-transferir");
  {
    const ended = await guard.check("post-transferir");
    if (ended) return ended;
  }
  await delay(1500);
  await capture("pre-autorizacion");
  {
    const ended = await guard.check("pre-autorizacion");
    if (ended) return ended;
  }

  progress("Seleccionando Mi Pass...");
  {
    const ended = await guard.check("pre-mipass");
    if (ended) return ended;
  }

  /** True si el desafío ya está en curso (NO re-clickear). */
  const isMiPassAuthorizing = async (): Promise<boolean> => {
    try {
      const body = await page.evaluate(
        () => (document.body && (document.body.innerText || document.body.textContent || "")) || "",
      );
      if (isMiPassAuthorizingText(body)) return true;
    } catch {
      // ignore transient nav
    }
    return page.evaluate(() => {
      const el = document.querySelector(".minerva-card-secondary-resume.authorize-card");
      if (!el) return false;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || el.classList.contains("ng-hide")) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  };

  /**
   * Click DOM nativo (HTMLElement.click + eventos) en vez de mouse CDP por coords.
   * El click sintético de Puppeteer (Input.dispatchMouseEvent) a veces hace que el
   * POST pagar-express / SSO obrareq falle con intermitencias.
   */
  const clickMiPassDom = () => page.evaluate(() => {
    const body = (document.body && (document.body.innerText || document.body.textContent || "")) || "";
    if (/autorizando\s+con\s+mi\s*pass/i.test(body)) {
      return { ok: false, reason: "already-authorizing" as const };
    }

    const pick = (): HTMLElement | null => {
      const specific = document.querySelector(".card-left-content-miPass") as HTMLElement | null;
      if (specific) {
        return (specific.closest(".authorize-card-item") as HTMLElement) || specific;
      }
      const cards = Array.from(document.querySelectorAll(".authorize-card-item")) as HTMLElement[];
      for (const card of cards) {
        const text = card.textContent || "";
        if (text.includes("Mi Pass") && !text.includes("Digipass")) return card;
      }
      // Fallback: botón/caja con texto Mi Pass
      const nodes = Array.from(document.querySelectorAll("button, a, [role='button'], .authorize-card-item, .card-left-content-miPass")) as HTMLElement[];
      for (const el of nodes) {
        const text = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (/mi\s*pass/i.test(text) && !/digipass/i.test(text) && text.length < 80) return el;
      }
      return null;
    };

    const el = pick();
    if (!el) return { ok: false, reason: "not-found" as const };

    el.scrollIntoView({ block: "center", inline: "center" });
    try { el.focus({ preventScroll: true }); } catch { /* ignore */ }

    const fire = (type: string) => {
      el.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        buttons: 1,
      }));
    };
    fire("pointerdown");
    fire("mousedown");
    fire("mouseup");
    fire("pointerup");
    fire("click");
    // Angular/ng-click a veces escucha el click nativo del elemento.
    el.click();
    return { ok: true, reason: "clicked" as const, tag: el.tagName, className: String(el.className || "").slice(0, 120) };
  });

  const hasMiPassCard = () => page.evaluate(() => {
    if (document.querySelector(".card-left-content-miPass")) return true;
    const cards = Array.from(document.querySelectorAll(".authorize-card-item"));
    return cards.some((card) => {
      const text = card.textContent || "";
      return text.includes("Mi Pass") && !text.includes("Digipass");
    });
  });

  // Un solo click a Mi Pass. Reintentos de click disparan otro pagar-express
  // y rompen el SSO (obrareq) → "Presentamos intermitencias".
  let miPassActive = await isMiPassAuthorizing();
  if (!miPassActive) {
    {
      const ended = await guard.check("pre-mipass-click");
      if (ended) return ended;
    }
    let cardReady = await hasMiPassCard();
    if (!cardReady) {
      for (let wait = 0; wait < 5 && !cardReady; wait++) {
        await delay(1000);
        const ended = await guard.check(`esperando-card-mipass-${wait + 1}`);
        if (ended) return ended;
        if (await isMiPassAuthorizing()) {
          miPassActive = true;
          break;
        }
        cardReady = await hasMiPassCard();
      }
    }
    if (!miPassActive) {
      if (!cardReady) {
        const blocked = await guard.check("sin-card-mipass");
        if (blocked) return blocked;
        await capture("sin-card-mipass");
        return { success: false, error: "No se encontró el card TRANSFIERE CON Mi Pass en la página." };
      }

      const clickResult = await clickMiPassDom();
      progress(`Click Mi Pass vía DOM (${clickResult.reason}${clickResult.className ? `: ${clickResult.className}` : ""})`);
      if (!clickResult.ok && clickResult.reason !== "already-authorizing") {
        await capture("sin-card-mipass");
        return { success: false, error: "No se pudo hacer click DOM en TRANSFIERE CON Mi Pass." };
      }
      await capture("despues-click-mipass");

      // Esperar a "AUTORIZANDO CON MI PASS" sin volver a clickear.
      for (let wait = 0; wait < 15 && !miPassActive; wait++) {
        await delay(1000);
        {
          const ended = await guard.check(`post-mipass-click-${wait + 1}`);
          if (ended) return ended;
        }
        miPassActive = await isMiPassAuthorizing();
      }
    }
  }

  if (!miPassActive) {
    await capture("mipass-no-activo");
    return { success: false, error: "No se pudo activar Mi Pass. La notificación no se envió al teléfono." };
  }
  await capture("mipass-activo");

  progress("Autoriza la operación en tu app Mi Pass...");
  const miPassStart = Date.now();
  let confirmationFound: string | null = null;

  const detectPageState = () => page.evaluate(() => {
    const bodyText = (document.body && (document.body.innerText || document.body.textContent || "")) || "";
    const t = bodyText.toLowerCase();
    if (t.includes("presentamos intermitencias") || t.includes("no pudimos completar la operación")) {
      return { state: "error_intermitency", message: "El banco presentó intermitencias.", text: "" };
    }
    const successPhrases = [
      "la operación se ha iniciado",
      "operación se ha iniciado",
      "descargar comprobante",
      "transferencia realizada",
      "operación exitosa",
      "completada exitosamente",
      "transferencia completada",
    ];
    const hasSessionEnd = t.includes("sesión finalizada") || t.includes("sesion finalizada");
    if (successPhrases.some((p) => t.includes(p)) && !hasSessionEnd) {
      return { state: "success", message: "", text: bodyText.slice(0, 500) };
    }
    if (hasSessionEnd) {
      return { state: "session_ended", message: "", text: "" };
    }
    return { state: "waiting", message: "", text: "" };
  });

  while (Date.now() - miPassStart < timeoutMs) {
    await delay(MIPASS_POLL_INTERVAL_MS);
    {
      const ended = await guard.check("mipass-espera");
      if (ended) return ended;
    }
    const result = await detectPageState();
    const elapsed = Math.round((Date.now() - miPassStart) / 1000);
    if (result.state === "session_ended") {
      await capture("sesion-finalizada-mipass");
      return { success: false, error: SESSION_FINALIZADA_ERROR };
    }
    if (result.state === "error_intermitency") {
      return { success: false, error: result.message || "El banco presentó intermitencias." };
    }
    if (result.state === "success") {
      confirmationFound = result.text || "";
      break;
    }
    progress(`Esperando aprobación Mi Pass... (${elapsed}s)`);
    if (elapsed === 5 || elapsed % 30 === 0) {
      await capture(`mipass-espera-${elapsed}s`);
    }
  }

  if (!confirmationFound) {
    await capture("mipass-timeout");
    return { success: false, error: "Tiempo de espera agotado. Apruebe Mi Pass antes de que expire." };
  }

  progress("Transferencia confirmada");
  await delay(2000);
  await capture("comprobante");

  const comprobante = await page.evaluate((): TransferenciaComprobante => {
    const body = (document.body && document.body.innerText) || "";
    const nOpMatch = body.match(/N[°º]\s*de\s*operaci[oó]n\s*[:\s]*(\d+)/i);
    const montoMatch = body.match(/Monto\s*[:\s]*\$\s*([\d.,]+)/i);
    const getText = (label: string) => {
      const all = document.querySelectorAll("*");
      for (const el of all) {
        const t = (el.textContent || "").trim().toLowerCase();
        if (t.startsWith(label.toLowerCase()) && el.children.length === 0 && t.length < 100) {
          const next = el.nextElementSibling;
          if (next) return (next.textContent || "").trim();
        }
      }
      return null;
    };
    return {
      n_operacion: nOpMatch ? nOpMatch[1] : getText("N° de operación"),
      monto: montoMatch ? montoMatch[1] : getText("Monto"),
      nombre_destino: getText("Nombre de destino"),
      rut_destino: getText("RUT de destino"),
      banco_destino: getText("Banco de destino"),
      cuenta_destino: getText("Cuenta de destino"),
      cuenta_origen: getText("Cuenta de origen"),
    };
  });

  return {
    success: true,
    estado: "LIBERADA",
    idOperacion: comprobante.n_operacion || null,
    comprobante,
    confirmacion: confirmationFound.slice(0, 300),
  };
  } finally {
    guard.stop();
  }
}
