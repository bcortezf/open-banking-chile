import { describe, it, expect, afterEach, vi } from "vitest";
import type { Page } from "puppeteer-core";
import { extractCreditCardMovements } from "./credit-card.js";
import { MOVEMENT_SOURCE } from "../types.js";

type Cell = { innerText: string };
type Row = { querySelectorAll: (sel: string) => Cell[] };

/** Minimal DOM: one table with Fecha / Detalle / Monto headers and the given rows. */
function stubDocument(rows: string[][]): void {
  const headers: Cell[] = ["Fecha", "Detalle", "Monto"].map((innerText) => ({ innerText }));
  const trs: Row[] = rows.map((cells) => ({
    querySelectorAll: () => cells.map((innerText) => ({ innerText })),
  }));
  const table = {
    querySelectorAll: (sel: string) => (sel === "th" ? headers : sel === "tbody tr" ? trs : []),
  };
  vi.stubGlobal("document", { querySelectorAll: (sel: string) => (sel === "table" ? [table] : []) });
}

/**
 * Runs page.evaluate callbacks the way a real browser does: serialized to source and
 * evaluated with no access to the Node module scope. A callback that references a helper
 * defined in this module throws ReferenceError, exactly like in Chrome.
 */
function isolatedPage(): Page {
  return {
    evaluate: async (fn: (...a: unknown[]) => unknown, ...args: unknown[]) =>
      new Function(`return (${fn.toString()}).apply(null, arguments[0])`)(args),
  } as unknown as Page;
}

afterEach(() => vi.unstubAllGlobals());

describe("extractCreditCardMovements", () => {
  it("runs its page.evaluate callback without relying on Node-scope helpers", async () => {
    stubDocument([
      ["05/08/2026", "Saldo Inicial", "$100.000"],
      ["06/08/2026", "COMPRA SUPERMERCADO", "$12.345"],
    ]);

    const result = await extractCreditCardMovements(isolatedPage(), "unbilled");

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ description: "COMPRA SUPERMERCADO", amount: -12345 });
  });

  it("tags every movement as CLP by default", async () => {
    stubDocument([["06/08/2026", "COMPRA", "$1.000"]]);

    const [m] = await extractCreditCardMovements(isolatedPage(), "billed");

    expect(m.currency).toBe("CLP");
    expect(m.source).toBe(MOVEMENT_SOURCE.credit_card_billed);
  });

  it("tags movements with the given currency and keeps USD cents", async () => {
    stubDocument([["06/08/2026", "AMAZON", "US$ 12,34"]]);

    const [m] = await extractCreditCardMovements(isolatedPage(), "unbilled", "USD");

    expect(m.currency).toBe("USD");
    expect(m.amount).toBe(-12.34);
  });
});
