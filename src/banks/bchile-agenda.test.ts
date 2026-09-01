import { describe, it, expect } from "vitest";
import {
  findBeneficiarioEnAgenda,
  normalizeNumeroCuenta,
  normalizeRutAgenda,
  parseAgendaResponse,
} from "./bchile-agenda.js";

describe("normalizeRutAgenda", () => {
  it("quita puntos y espacios", () => {
    expect(normalizeRutAgenda("12.345.678-9")).toBe("12345678-9");
    expect(normalizeRutAgenda(" 12345678-9 ")).toBe("12345678-9");
  });

  it("mayúsculas en DV", () => {
    expect(normalizeRutAgenda("13622350-k")).toBe("13622350-K");
  });

  it("vacío para null/undefined", () => {
    expect(normalizeRutAgenda(null)).toBe("");
    expect(normalizeRutAgenda(undefined)).toBe("");
  });
});

describe("normalizeNumeroCuenta", () => {
  it("deja solo dígitos", () => {
    expect(normalizeNumeroCuenta("00-020-50253-56")).toBe("000205025356");
    expect(normalizeNumeroCuenta(" 205025356 ")).toBe("205025356");
  });

  it("vacío para null", () => {
    expect(normalizeNumeroCuenta(null)).toBe("");
  });
});

describe("findBeneficiarioEnAgenda", () => {
  const lista = [
    { rutBeneficiario: "12.345.678-9", numeroCuenta: "61021064", nombreRazonSocial: "ACME" },
    { rutBeneficiario: "20020177-9", numeroCuenta: "205025356", nombreRazonSocial: "TICKEFY" },
  ];

  it("encuentra por RUT y cuenta exactos", () => {
    const match = findBeneficiarioEnAgenda(lista, "12345678-9", "61021064");
    expect(match?.nombreRazonSocial).toBe("ACME");
  });

  it("acepta sufijo de cuenta", () => {
    const match = findBeneficiarioEnAgenda(lista, "20.020.177-9", "025356");
    expect(match?.nombreRazonSocial).toBe("TICKEFY");
  });

  it("retorna null si no hay match", () => {
    expect(findBeneficiarioEnAgenda(lista, "11111111-1", "999")).toBeNull();
  });
});

describe("parseAgendaResponse", () => {
  it("acepta array directo", () => {
    expect(parseAgendaResponse([{ rutBeneficiario: "1" }])).toHaveLength(1);
  });

  it("acepta listaBeneficiarios", () => {
    expect(parseAgendaResponse({ listaBeneficiarios: [{ a: 1 }, { b: 2 }] })).toHaveLength(2);
  });

  it("acepta destinatarios", () => {
    expect(parseAgendaResponse({ destinatarios: [{ a: 1 }] })).toHaveLength(1);
  });

  it("vacío si no hay lista", () => {
    expect(parseAgendaResponse({ ok: true })).toEqual([]);
  });
});
