import type { Page } from "puppeteer-core";
import type { TransferenciaComprobante, TransferenciaExpressData, TransferenciaResult } from "../types.js";
import { delay } from "../utils.js";

export type TransferShotFn = (page: Page, name: string) => Promise<void>;

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

  progress(`Navegando al formulario de transferencia express (***${lastThreeDigits})...`);

  try {
    await page.goto(TRANSFER_EXPRESS_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch {
    // SPA hash navigation
  }
  await delay(3000);

  let formReady = await page.evaluate(() => document.querySelectorAll(".ui-select-container").length >= 2);
  if (!formReady) {
    await delay(5000);
    formReady = await page.evaluate(() => document.querySelectorAll(".ui-select-container").length >= 2);
  }
  if (!formReady) {
    await capture("form-no-cargo");
    return { success: false, error: "El formulario de transferencia express no cargó." };
  }
  await capture("formulario-listo");

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
    await page.evaluate(() => {
      const options = Array.from(document.querySelectorAll(".ui-select-choices-row > a, .ui-select-choices-row-inner > a"));
      if (options.length > 0) (options[0] as HTMLElement).click();
    });
    await delay(500);
    await capture("cuenta-origen-seleccionada");
  } else {
    await capture("cuenta-origen-preseleccionada");
  }

  progress("Seleccionando beneficiario...");
  await delay(600);

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
  await delay(2000);
  await capture("despues-click-transferir");

  const sessionEnded = await page.evaluate(() => {
    const t = ((document.body && document.body.innerText) || "").toLowerCase();
    return t.includes("sesión finalizada") || t.includes("sesion finalizada");
  });
  if (sessionEnded) {
    return { success: false, error: "La sesión del portal fue finalizada. Reintente." };
  }

  progress("Seleccionando Mi Pass...");
  const isMiPassActivated = () => page.evaluate(() => {
    const el = document.querySelector(".minerva-card-secondary-resume.authorize-card");
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || el.classList.contains("ng-hide")) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });

  const getMiPassRect = () => page.evaluate(() => {
    const specific = document.querySelector(".card-left-content-miPass");
    if (specific) {
      const parent = (specific.closest(".authorize-card-item") || specific) as HTMLElement;
      parent.scrollIntoView({ block: "center" });
      const r = parent.getBoundingClientRect();
      if (r.width > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }
    const cards = Array.from(document.querySelectorAll(".authorize-card-item"));
    for (const card of cards) {
      const text = card.textContent || "";
      if (text.includes("Mi Pass") && !text.includes("Digipass")) {
        (card as HTMLElement).scrollIntoView({ block: "center" });
        const r = card.getBoundingClientRect();
        if (r.width > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
    }
    return null;
  });

  let miPassActive = false;
  for (let attempt = 1; attempt <= 4 && !miPassActive; attempt++) {
    const rect = await getMiPassRect();
    if (!rect) {
      await capture("sin-card-mipass");
      return { success: false, error: "No se encontró el card TRANSFIERE CON Mi Pass en la página." };
    }
    await page.mouse.click(rect.x, rect.y);
    await delay(2000);
    miPassActive = await isMiPassActivated();
    if (miPassActive) break;

    if (attempt === 2) {
      const innerRect = await page.evaluate(() => {
        const el = document.querySelector(".text-content-cajaDesafio");
        if (!el || !(el.textContent || "").includes("Mi Pass")) return null;
        (el as HTMLElement).scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        return r.width > 0 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
      });
      if (innerRect) {
        await page.mouse.click(innerRect.x, innerRect.y);
        await delay(2000);
      }
      miPassActive = await isMiPassActivated();
    }

    if (attempt === 3) {
      try {
        await page.click(".card-left-content-miPass");
        await delay(2000);
        miPassActive = await isMiPassActivated();
      } catch {
        // ignore
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
    const result = await detectPageState();
    const elapsed = Math.round((Date.now() - miPassStart) / 1000);
    if (result.state === "session_ended") {
      return { success: false, error: "La sesión del portal fue finalizada. Reintente." };
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
}
