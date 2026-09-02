import { describe, expect, it } from "vitest";
import {
  EXPRESS_NOT_READY_ERROR,
  isSessionFinalizadaText,
  isTefSaldoUrl,
  isTransientNavError,
  pageHasSaldoEnCuentaText,
  SESSION_FINALIZADA_ERROR,
} from "./bchile-transfer.js";

describe("isSessionFinalizadaText", () => {
  it("detecta el modal Sesión Finalizada", () => {
    const modal = `
      Sesión Finalizada
      Por su seguridad, la sesión fue finalizada.
      Si desea continuar, debe volver a ingresar.
      REINGRESAR
    `;
    expect(isSessionFinalizadaText(modal)).toBe(true);
  });

  it("detecta variantes sin tilde", () => {
    expect(isSessionFinalizadaText("Sesion Finalizada. Por su seguridad...")).toBe(true);
    expect(isSessionFinalizadaText("la sesion fue finalizada")).toBe(true);
  });

  it("no marca falsos positivos en el formulario TEF normal", () => {
    expect(isSessionFinalizadaText("Transferencia Express Beneficiario Busque por RUT")).toBe(false);
    expect(isSessionFinalizadaText("")).toBe(false);
  });

  it("expone mensaje de error estable", () => {
    expect(SESSION_FINALIZADA_ERROR).toMatch(/sesión del portal fue finalizada/i);
  });
});

describe("pageHasSaldoEnCuentaText", () => {
  it("detecta el bloque listo de Express", () => {
    expect(pageHasSaldoEnCuentaText("Cuenta de Origen\nSaldo en Cuenta: $32.292")).toBe(true);
    expect(pageHasSaldoEnCuentaText("saldo en cuenta: $1")).toBe(true);
  });

  it("no acepta el formulario vacío sin saldo", () => {
    expect(pageHasSaldoEnCuentaText("Transferencia Express Datos de la Transferencia")).toBe(false);
  });
});

describe("isTefSaldoUrl", () => {
  it("reconoce la request de saldo", () => {
    expect(
      isTefSaldoUrl(
        "https://portalempresas.bancochile.cl/mibancochile/rest/empresa/tef-rest/tef/saldo?numeroCuenta=205025356",
      ),
    ).toBe(true);
    expect(isTefSaldoUrl("https://example.com/other")).toBe(false);
  });

  it("expone error de sección no lista", () => {
    expect(EXPRESS_NOT_READY_ERROR).toMatch(/Saldo en Cuenta/i);
  });
});

describe("isTransientNavError", () => {
  it("reconoce context destroyed / target closed", () => {
    expect(isTransientNavError(new Error("Execution context was destroyed, most likely because of a navigation."))).toBe(true);
    expect(isTransientNavError(new Error("Protocol error (Page.captureScreenshot): Target closed"))).toBe(true);
    expect(isTransientNavError(new Error("No se encontró el beneficiario"))).toBe(false);
  });
});
