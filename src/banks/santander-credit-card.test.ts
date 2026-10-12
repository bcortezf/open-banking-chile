import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Page } from "puppeteer-core";
import type { BankMovement } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import type { Interceptor } from "../intercept.js";

vi.mock("../actions/credit-card.js", () => ({
  clickTcTab: vi.fn(),
  extractCreditCardMovements: vi.fn(),
}));

import { clickTcTab, extractCreditCardMovements } from "../actions/credit-card.js";
import { collectCreditCardTab } from "./santander.js";

const page = {} as Page;
const clickTab = vi.mocked(clickTcTab);
const extractHtml = vi.mocked(extractCreditCardMovements);

function mov(description: string, amount: number): BankMovement {
  return { date: "01-08-2026", description, amount, balance: 0, source: MOVEMENT_SOURCE.credit_card_unbilled };
}

/** waitFor returns the queued responses in order; clear() is recorded. */
function fakeInterceptor(queue: unknown[][]): Interceptor & { cleared: string[] } {
  const cleared: string[] = [];
  return {
    cleared,
    getAll: () => [],
    waitFor: async () => queue.shift() ?? [],
    clear: (id: string) => void cleared.push(id),
  };
}

const normalize = (captures: unknown[]): BankMovement[] =>
  captures.map((c) => mov(String(c), -100));

function run(interceptor: Interceptor, debugLog: string[] = []) {
  return collectCreditCardTab(page, interceptor, debugLog, {
    tabText: "movimientos por facturar",
    endpointId: "santander-credit-card-unbilled",
    tab: "unbilled",
    normalize,
    logLabel: "TC por facturar",
  });
}

beforeEach(() => {
  clickTab.mockReset();
  extractHtml.mockReset();
  clickTab.mockResolvedValue(true);
  extractHtml.mockResolvedValue([]);
});

describe("collectCreditCardTab", () => {
  it("returns nothing and touches no endpoint when the tab cannot be opened", async () => {
    clickTab.mockResolvedValueOnce(false);
    const interceptor = fakeInterceptor([["x"]]);

    expect(await run(interceptor)).toEqual([]);
    expect(clickTab).toHaveBeenCalledTimes(1);
  });

  it("tags API movements with the currency of the sub-tab they came from", async () => {
    const result = await run(fakeInterceptor([["peso-1", "peso-2"], ["usd-1"]]));

    expect(result.map((m) => [m.description, m.currency])).toEqual([
      ["peso-1", "CLP"],
      ["peso-2", "CLP"],
      ["usd-1", "USD"],
    ]);
  });

  it("clears the endpoint before switching to dólares so stale pesos captures are not reused", async () => {
    const interceptor = fakeInterceptor([["peso-1"], ["usd-1"]]);

    await run(interceptor);

    expect(interceptor.cleared).toEqual(["santander-credit-card-unbilled"]);
    expect(clickTab.mock.calls.map((c) => c[1])).toEqual([
      "movimientos por facturar",
      "dólares",
      "pesos",
    ]);
  });

  it("falls back to HTML extraction, with the right currency, when a sub-tab exposes no API data", async () => {
    extractHtml.mockImplementation(async (_p, _tab, currency) => [
      { ...mov(`html-${currency}`, -50), currency },
    ]);

    const result = await run(fakeInterceptor([[], []]));

    expect(extractHtml).toHaveBeenCalledWith(page, "unbilled", "CLP");
    expect(extractHtml).toHaveBeenCalledWith(page, "unbilled", "USD");
    expect(result.map((m) => m.description)).toEqual(["html-CLP", "html-USD"]);
  });

  it("keeps the pesos movements and logs when the dólares sub-tab cannot be opened", async () => {
    clickTab.mockResolvedValueOnce(true); // main tab
    clickTab.mockResolvedValueOnce(false); // dólares
    const debugLog: string[] = [];

    const result = await run(fakeInterceptor([["peso-1"]]), debugLog);

    expect(result.map((m) => m.currency)).toEqual(["CLP"]);
    expect(debugLog.join("\n")).toContain("no se pudo cambiar a dólares");
  });
});
