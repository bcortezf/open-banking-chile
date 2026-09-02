import type { Page } from "puppeteer-core";

/** Args comunes para reducir señales de automatización en Chrome. */
export const STEALTH_LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--window-size=1366,768",
  "--disable-blink-features=AutomationControlled",
  "--lang=es-CL,es",
];

/** Puppeteer agrega --enable-automation; conviene ignorarlo. */
export const STEALTH_IGNORE_DEFAULT_ARGS = ["--enable-automation"];

/**
 * No forzar un UA de Windows si el Chrome real es Linux: el mismatch
 * plataforma/UA es una señal clásica de bot.
 */
export function preferredUserAgent(): string | null {
  // null = dejar el UA nativo del Chrome/Chromium instalado.
  if (process.env.BANCO_FORCE_USER_AGENT === "false") return null;
  const forced = (process.env.BANCO_FORCE_USER_AGENT || "").trim();
  if (forced) return forced;
  return null;
}

/** Parches livianos de fingerprint (sin dependencias externas). */
export async function applyStealth(page: Page): Promise<void> {
  const ua = preferredUserAgent();
  if (ua) {
    await page.setUserAgent(ua);
  }

  await page.setExtraHTTPHeaders({
    "Accept-Language": "es-CL,es;q=0.9,en;q=0.8",
  });

  await page.evaluateOnNewDocument(() => {
    try {
      Object.defineProperty(navigator, "webdriver", {
        get: () => undefined,
        configurable: true,
      });
    } catch {
      // ignore
    }

    const nav = navigator as Navigator & { chrome?: unknown };
    if (!nav.chrome) {
      (nav as { chrome: unknown }).chrome = { runtime: {} };
    }

    try {
      Object.defineProperty(navigator, "languages", {
        get: () => ["es-CL", "es", "en-US", "en"],
        configurable: true,
      });
    } catch {
      // ignore
    }

    try {
      Object.defineProperty(navigator, "plugins", {
        get: () => [1, 2, 3, 4, 5],
        configurable: true,
      });
    } catch {
      // ignore
    }

    // Permissions.query(notifications) suele delatar headless.
    const originalQuery = window.navigator.permissions?.query?.bind(window.navigator.permissions);
    if (originalQuery) {
      window.navigator.permissions.query = (parameters: PermissionDescriptor) => {
        if (parameters && parameters.name === "notifications") {
          return Promise.resolve({ state: Notification.permission } as PermissionStatus);
        }
        return originalQuery(parameters);
      };
    }
  });
}
