import { describe, expect, it } from "vitest";
import { normalizeDate, parseChileanAmount } from "../utils.js";
import { parseEmpresaAccountsText, parseEmpresaMovementsText } from "./scotiabank.js";

describe("Scotia Empresas date/amount helpers", () => {
  it("normalizes '03 Ago, 2026'", () => {
    expect(normalizeDate("03 Ago, 2026")).toBe("03-08-2026");
  });

  it("parses signed Chilean amounts", () => {
    expect(parseChileanAmount("-$ 24.180")).toBe(-24180);
    expect(parseChileanAmount("+$ 8.504")).toBe(8504);
    expect(parseChileanAmount("$ 196.132")).toBe(196132);
  });
});

describe("parseEmpresaAccountsText", () => {
  it("parses corriente + dolar cards", () => {
    const text =
      "Cuenta Corriente (****0501)$ 196.132 Saldo Contable $ 196.132 Cuenta Dólar (****7718) USD 0,00";
    const accounts = parseEmpresaAccountsText(text);
    expect(accounts).toHaveLength(2);
    expect(accounts[0]).toMatchObject({ label: "Cuenta Corriente (****0501)", balance: 196132 });
    expect(accounts[1].label).toContain("Dólar");
  });
});

describe("parseEmpresaMovementsText", () => {
  it("does not treat RUT digits as operation number", () => {
    const text = `
Últimos movimientos
FECHA DESCRIPCIÓN N° OPERACIÓN MONTO SALDO
03 Ago, 2026 TEF 78334698-2 TECHSAKI SPA VIRTUAL EMPRESAS DIGITAL 5820002234 -$ 24.180 $ 196.132
01 Jul, 2026 ABONO CIERRE CTA VIRTUAL EMPRESAS DIGITAL 991387985 $ 8.504 $ 255.706
`;
    const rows = parseEmpresaMovementsText(text);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0].description).toContain("TECHSAKI");
    expect(rows[0].amount).toContain("24.180");
    expect(rows[0].tipo).toBe("cargo");
    expect(normalizeDate(rows[0].date)).toBe("03-08-2026");
    expect(rows[1].tipo).toBe("abono");
  });
});
