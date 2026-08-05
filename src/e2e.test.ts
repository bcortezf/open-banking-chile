import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeAll } from "vitest";
import { getBank } from "./index.js";
import type { BankMovement, CreditCardBalance, ScrapeResult } from "./types.js";

/**
 * Tests E2E contra portales bancarios reales.
 *
 * SOLO se ejecutan cuando existen las credenciales de entorno (GitHub Secrets
 * en CI, o .env en local). Si no hay credenciales para un banco, ese suite
 * se marca como skipped.
 *
 * Una sola consulta por banco (`beforeAll`) alimenta todos los casos — no se
 * vuelve a scrapear por cada `it`. Exige `success: true`; si el scrape falla,
 * el suite entero falla con el `error`. Solo se skipean asserts de datos
 * opcionales (movimientos / TC) cuando ese banco no los trae.
 *
 * Bancos: `E2E_BANKS=bchile,falabella` (default) o `E2E_BANK=falabella`.
 *
 * ⚠️ En CI se ejecutan en el workflow e2e.yml, que requiere aprobación manual
 *    de un mantenedor (Environment "e2e") — los secrets nunca se imprimen.
 */

/** Carga `.env` local si existe (no pisa vars ya definidas, p.ej. CI). */
function loadDotEnv(): void {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

loadDotEnv();

const DEFAULT_BANKS = ["bchile", "falabella"];
const DATE_RE = /^\d{2}-\d{2}-\d{4}$/;
const MOVEMENT_SOURCES = new Set([
  "account",
  "credit_card_unbilled",
  "credit_card_billed",
]);

function resolveBanks(): string[] {
  if (process.env.E2E_BANKS) {
    return process.env.E2E_BANKS.split(",")
      .map((b) => b.trim().toLowerCase())
      .filter(Boolean);
  }
  if (process.env.E2E_BANK) {
    return [process.env.E2E_BANK.trim().toLowerCase()];
  }
  return DEFAULT_BANKS;
}

function credsAvailable(bankId: string): boolean {
  const prefix = bankId.toUpperCase();
  return Boolean(process.env[`${prefix}_RUT`] && process.env[`${prefix}_PASS`]);
}

function expectValidMovement(m: BankMovement): void {
  expect(m.date).toMatch(DATE_RE);
  expect(typeof m.description).toBe("string");
  expect(m.description.length).toBeGreaterThan(0);
  expect(typeof m.amount).toBe("number");
  expect(Number.isFinite(m.amount)).toBe(true);
  expect(typeof m.balance).toBe("number");
  expect(Number.isFinite(m.balance)).toBe(true);
  expect(MOVEMENT_SOURCES.has(m.source)).toBe(true);
  if (m.owner !== undefined) {
    expect(["titular", "adicional"]).toContain(m.owner);
  }
  if (m.installments !== undefined) {
    expect(m.installments).toMatch(/^\d{2}\/\d{2}$/);
  }
}

function expectValidCreditCard(card: CreditCardBalance): void {
  expect(typeof card.label).toBe("string");
  expect(card.label.length).toBeGreaterThan(0);
  if (card.national) {
    expect(typeof card.national.used).toBe("number");
    expect(typeof card.national.available).toBe("number");
    expect(typeof card.national.total).toBe("number");
  }
  if (card.international) {
    expect(typeof card.international.used).toBe("number");
    expect(typeof card.international.available).toBe("number");
    expect(typeof card.international.total).toBe("number");
    expect(typeof card.international.currency).toBe("string");
  }
}

function registerBankE2E(bankId: string): void {
  describe.skipIf(!credsAvailable(bankId))(`E2E ${bankId} (cuentas reales)`, () => {
    const rut = process.env[`${bankId.toUpperCase()}_RUT`] || "";
    const pass = process.env[`${bankId.toUpperCase()}_PASS`] || "";

    /** Resultado único compartido por todos los tests del suite */
    let result: ScrapeResult;

    beforeAll(async () => {
      const bank = getBank(bankId);
      if (!bank) throw new Error(`Banco ${bankId} no encontrado`);

      result = await bank.scrape({
        rut,
        password: pass,
        chromePath: process.env.CHROME_PATH,
        scope: { type: "personal" },
      });

      // El E2E exige consulta real exitosa. Si falla el login/scrape, el suite entero falla.
      if (!result.success) {
        throw new Error(
          `Scrape ${bankId} falló (success=false): ${result.error ?? "(sin mensaje de error)"}`,
        );
      }
    }, 180_000);

    it("consulta exitosa (success: true) con estructura básica", () => {
      expect(result.success).toBe(true);
      expect(result.bank).toBe(bankId);
      // Compat: flat movements y/o accounts[]
      const hasMovementsArray = Array.isArray(result.movements);
      const hasAccountsArray = Array.isArray(result.accounts);
      expect(hasMovementsArray || hasAccountsArray).toBe(true);
    });

    it("no expone credenciales en el resultado", () => {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(pass);
      const rutDigits = rut.replace(/\./g, "").replace(/-/g, "");
      expect(serialized).not.toContain(rutDigits);
    });

    it("valida estructura de accounts[] si existen", ({ skip }) => {
      if (!result.accounts?.length) {
        skip();
        return;
      }
      for (const account of result.accounts) {
        expect(Array.isArray(account.movements)).toBe(true);
        if (account.balance !== undefined) {
          expect(typeof account.balance).toBe("number");
          expect(Number.isFinite(account.balance)).toBe(true);
        }
        if (account.label !== undefined) {
          expect(typeof account.label).toBe("string");
          expect(account.label.length).toBeGreaterThan(0);
        }
      }
    });

    it("valida forma de movimientos (flat o por cuenta) si existen", ({ skip }) => {
      const fromAccounts = (result.accounts ?? []).flatMap((a) => a.movements);
      const flat = result.movements ?? [];
      const all = [...flat, ...fromAccounts];

      if (all.length === 0) {
        skip();
        return;
      }

      for (const mov of all) {
        expectValidMovement(mov);
      }
    });

    it("valida tarjetas de crédito si existen", ({ skip }) => {
      if (!result.creditCards?.length) {
        skip();
        return;
      }

      for (const card of result.creditCards) {
        expectValidCreditCard(card);
      }
    });

    it("valida movimientos de TC si alguna tarjeta los trae", ({ skip }) => {
      const ccMovements = (result.creditCards ?? []).flatMap((c) => c.movements ?? []);
      if (ccMovements.length === 0) {
        skip();
        return;
      }

      for (const mov of ccMovements) {
        expectValidMovement(mov);
      }
    });
  });
}

for (const bankId of resolveBanks()) {
  registerBankE2E(bankId);
}
