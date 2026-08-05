import { describe, it, expect } from "vitest";
import { cartolaMovToMovement, normalizeRutBeneficiario } from "./bchile.js";
import { MOVEMENT_SOURCE } from "../types.js";

describe("normalizeRutBeneficiario", () => {
  it("mantiene RUT con formato correcto", () => {
    expect(normalizeRutBeneficiario("12345678-9")).toBe("12345678-9");
  });

  it("normaliza RUT sin guión", () => {
    expect(normalizeRutBeneficiario("123456789")).toBe("12345678-9");
  });

  it("normaliza RUT con puntos", () => {
    expect(normalizeRutBeneficiario("12.345.678-9")).toBe("12345678-9");
  });

  it("maneja dígito verificador K", () => {
    expect(normalizeRutBeneficiario("13622350k")).toBe("13622350-K");
    expect(normalizeRutBeneficiario("13.622.350-K")).toBe("13622350-K");
  });

  it("maneja RUT corto (sin DV)", () => {
    expect(normalizeRutBeneficiario("1234567")).toBe("1234567");
  });

  it("limpia espacios", () => {
    expect(normalizeRutBeneficiario(" 12345678-9 ")).toBe("12345678-9");
  });
});

describe("cartolaMovToMovement", () => {
  it("coerciona monto/saldo string de la API a number", () => {
    const mov = cartolaMovToMovement({
      descripcion: " Transferencia ",
      monto: "5153",
      saldo: "99594",
      tipo: "cargo",
      fechaContable: "2026-07-24",
    });
    expect(typeof mov.amount).toBe("number");
    expect(typeof mov.balance).toBe("number");
    expect(mov.amount).toBe(-5153);
    expect(mov.balance).toBe(99594);
    expect(mov.source).toBe(MOVEMENT_SOURCE.account);
  });

  it("acepta monto/saldo numéricos", () => {
    const mov = cartolaMovToMovement({
      descripcion: "Abono",
      monto: 1000,
      saldo: 5000,
      tipo: "abono",
      fechaContable: "24-07-2026",
    });
    expect(mov.amount).toBe(1000);
    expect(mov.balance).toBe(5000);
  });
});
