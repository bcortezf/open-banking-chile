import { describe, it, expect } from "vitest";
import { getBank } from "./index.js";

/**
 * Tests E2E contra el portal bancario real.
 *
 * SOLO se ejecutan cuando existen las credenciales de entorno (GitHub Secrets
 * en CI, o .env en local). Si no hay credenciales, se marcan como skipped.
 *
 * ⚠️ En CI se ejecutan en el workflow e2e.yml, que requiere aprobación manual
 *    de un mantenedor (Environment "e2e") — los secrets nunca se imprimen.
 */

const bankId = process.env.E2E_BANK || "bchile";

function credsAvailable(): boolean {
  const prefix = bankId.toUpperCase();
  return Boolean(process.env[`${prefix}_RUT`] && process.env[`${prefix}_PASS`]);
}

describe.skipIf(!credsAvailable())(`E2E ${bankId} (cuentas reales)`, () => {
  const rut = process.env[`${bankId.toUpperCase()}_RUT`] || "";
  const pass = process.env[`${bankId.toUpperCase()}_PASS`] || "";

  it("consulta cuentas con credenciales reales", async () => {
    const bank = getBank(bankId);
    if (!bank) throw new Error(`Banco ${bankId} no encontrado`);

    const result = await bank.scrape({
      rut,
      password: pass,
      chromePath: process.env.CHROME_PATH,
      scope: { type: "personal" },
    });

    // En E2E real aceptamos cualquier respuesta coherente (login OK + datos)
    if (result.success) {
      expect(result.bank).toBe(bankId);
      expect(Array.isArray(result.movements)).toBe(true);
    } else {
      // Si falló el login, debe ser por credenciales/2FA — no por crash interno
      expect(result.error).toMatch(/2FA|clave|bloqueada|login|sesión|timeout|credential/i);
    }
  }, 180_000);

  it("no expone credenciales en el resultado", async () => {
    const bank = getBank(bankId);
    if (!bank) throw new Error(`Banco ${bankId} no encontrado`);

    const result = await bank.scrape({
      rut,
      password: pass,
      chromePath: process.env.CHROME_PATH,
      scope: { type: "personal" },
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(pass);
    expect(serialized).not.toContain(rut.replace(/\./g, "").replace(/-/g, ""));
  }, 180_000);
});
