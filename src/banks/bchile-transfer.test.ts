import { describe, expect, it } from "vitest";
import { isSessionFinalizadaText, SESSION_FINALIZADA_ERROR } from "./bchile-transfer.js";

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
