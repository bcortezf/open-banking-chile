import { describe, it, expect } from "vitest";
import { normalizeRutBeneficiario } from "./bchile.js";

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
