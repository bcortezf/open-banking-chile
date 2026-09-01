# Open Banking Chile

> Guía completa para cualquier agente de IA. Framework open source de scrapers bancarios para Chile.

---

## 1. 📋 ¿Qué es esto?

**open-banking-chile** es un framework de scrapers para bancos chilenos. Extrae movimientos y saldos bancarios como JSON usando Puppeteer (Chrome headless). Todo corre 100% local en la máquina del usuario — **las credenciales nunca salen de su PC**.

**Stack:** TypeScript + Node.js + Puppeteer + Chromium

**Fork comunitario** del proyecto original open-banking-chile (licencia MIT).

---

## 2. 🏦 Bancos soportados (11)

| ID | Banco |
|----|-------|
| `falabella` | Banco Falabella (cuenta + CMR TC) |
| `bice` | Banco BICE |
| `santander` | Banco Santander |
| `edwards` | Banco Edwards |
| `scotiabank` | Scotiabank Chile |
| `bchile` | Banco de Chile (personas + empresas) |
| `bci` | BCI |
| `itau` | Itaú |
| `bestado` | Banco Estado (CuentaRUT) |
| `cencosud` | Tarjeta Cencosud |
| `bancosecurity` | Banco Security |

---

## 3. ⚡ Setup rápido

```bash
git clone https://github.com/bcortezf/open-banking-chile.git
cd open-banking-chile
npm install && npm run build
cp .env.example .env   # editar con credenciales reales
```

**Requisitos:** Node.js >= 18 + Google Chrome o Chromium.

> 💡 El CLI carga `.env` automáticamente. No necesita `source .env`.

---

## 4. 🚀 Uso

### CLI

```bash
node dist/cli.js --bank falabella --pretty           # Consulta completa
node dist/cli.js --bank falabella --movements | jq . # Solo movimientos
node dist/cli.js --list                               # Listar bancos
node dist/cli.js --help                               # Ayuda completa
```

**Flags disponibles:**

| Flag | Descripción |
|------|-------------|
| `--bank <id>` | Banco a consultar (requerido) |
| `--pretty` | JSON con indentación |
| `--movements` | Solo array de movimientos |
| `--screenshots` | Guarda screenshots en `./screenshots/` |
| `--headful` | Chrome visible (debugging). BancoEstado siempre requiere esto |
| `--owner <T\|A\|B>` | Filtro Titular/Adicional para TC (default: B) |
| `--empresa` | [BCHILE] Portal empresas |
| `--bankQuery <RUT>` | [BCHILE] RUT empresa específica |
| `--beneficiarios` | [BCHILE empresas] Listar agenda TEF |
| `--validar-cuenta` | [BCHILE empresas] ¿RUT+cuenta está en la agenda? |
| `--transferir` | [BCHILE empresas] Transferencia express + Mi Pass |
| `--add-beneficiario` | [BCHILE empresas] Agregar destinatario |

`ScraperOptions.page` acepta una Page Puppeteer ya autenticada (sesión persistente). En ese caso no se abre/cierra Chrome ni se hace login/logout.

### Como librería

```typescript
import { getBank, type BankMovement } from "open-banking-chile";

const bank = getBank("bchile");
const result = await bank!.scrape({
  rut: "12345678-9",
  password: "miclave",
});

if (result.success) {
  // Cuentas
  for (const account of result.accounts ?? []) {
    console.log(`Cuenta: $${account.balance}`);
    for (const mov of account.movements) {
      console.log(`${mov.date} | ${mov.description} | $${mov.amount}`);
    }
  }
  // Tarjetas de crédito
  for (const card of result.creditCards ?? []) {
    console.log(`${card.label}: usado $${card.national?.used}`);
    for (const mov of card.movements ?? []) {
      console.log(`${mov.date} | ${mov.description} [${mov.source}]`);
    }
  }
}
```

### Output típico

```json
{
  "success": true,
  "bank": "bchile",
  "accounts": [
    {
      "balance": 99594,
      "movements": [
        { "date": "24-07-2026", "description": "Pago:uber Trip", "amount": -5153, "balance": 0, "source": "account" }
      ]
    }
  ],
  "creditCards": [
    {
      "label": "Visa Signature ****4585",
      "national": { "used": 2227324, "available": 3872676, "total": 6100000 },
      "movements": [
        { "date": "23-07-2026", "description": "DISNEY PLUS", "amount": -17.14, "source": "credit_card_unbilled", "installments": "01/01" }
      ]
    }
  ]
}
```

### Campos de `BankMovement`

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `date` | string | `dd-mm-yyyy` |
| `description` | string | Descripción del movimiento |
| `amount` | number | Negativo = cargo/gasto, Positivo = abono/ingreso |
| `balance` | number | Saldo después del movimiento |
| `source` | `"account"` \| `"credit_card_unbilled"` \| `"credit_card_billed"` | Origen |
| `owner?` | `"titular"` \| `"adicional"` | Solo TC |
| `installments?` | string | Cuotas formato `"01/06"` |
| `card?` | string | Máscara de tarjeta `"****4585"` |

---

## 5. 🏗️ Arquitectura del proyecto

```
open-banking-chile/
├── src/
│   ├── index.ts          → Registro de bancos (getBank, listBanks)
│   ├── types.ts          → Interfaces (BankScraper, BankMovement, ScrapeResult, ScraperOptions)
│   ├── utils.ts          → Utilidades compartidas (ver sección 6)
│   ├── cli.ts            → Entry point CLI (parsea args, lee .env, ejecuta scraper)
│   └── banks/
│       ├── falabella.ts  → Banco Falabella + CMR
│       ├── bchile.ts     → Banco de Chile (personas + empresas, REST API)
│       ├── bci.ts        → BCI (iframes)
│       ├── bestado.ts    → Banco Estado (headful obligatorio)
│       ├── bice.ts       → Banco BICE
│       ├── cencosud.ts   → Tarjeta Cencosud (hCaptcha ocasional)
│       ├── edwards.ts    → Banco Edwards
│       ├── itau.ts       → Itaú
│       ├── santander.ts  → Banco Santander
│       ├── scotiabank.ts → Scotiabank Chile
│       └── bancosecurity.ts → Banco Security
├── .github/
│   ├── workflows/
│   │   └── ai-pr-review.yml → DeepSeek security CI en cada PR
│   └── scripts/
│       └── ai_review.py     → Análisis estático + IA de seguridad
├── dist/                 → Código compilado (npm run build)
├── .env                  → Credenciales (NO subir a git)
├── .env.example          → Template de credenciales
├── COMMUNITY.md          → Modelo de gobernanza comunitaria
├── CONTRIBUTING.md       → Guía para contribuidores
└── SECURITY.md           → Política de seguridad
```

---

## 6. 🛠️ Utilidades compartidas (`utils.ts`)

Funciones que todos los scrapers pueden y deben usar:

| Función | Propósito |
|---------|-----------|
| `formatRut(rut)` | Formatea RUT: `12345678-9` → `12.345.678-9` |
| `findChrome(path?)` | Busca Chrome/Chromium en el sistema |
| `delay(ms)` | Espera N milisegundos |
| `saveScreenshot(page, name, enabled, log)` | Guarda screenshot si habilitado |
| `closePopups(page)` | Cierra modales y popups genéricos |
| `logout(page, log)` | Cierra sesión buscando botones comunes |
| `parseChileanAmount(text)` | Parsea `$1.234.567` → `1234567` |
| `normalizeDate(raw)` | Normaliza cualquier formato a `dd-mm-yyyy` |
| `normalizeOwner(raw)` | Normaliza a `"titular"` o `"adicional"` |
| `normalizeInstallments(raw)` | Normaliza cuotas: `"1/6"` → `"01/06"` |
| `deduplicateMovements(movements)` | Elimina duplicados por fecha+descripción+monto+source |

---

## 7. 🆕 Cómo agregar un banco nuevo

### Interfaz a implementar

```typescript
import type { BankScraper, ScrapeResult, ScraperOptions } from "../types.js";

const scraper: BankScraper = {
  id: "mi-banco",                    // ID único, lowercase, sin espacios
  name: "Mi Banco Chile",            // Nombre comercial
  url: "https://www.mibanco.cl",     // URL del portal

  async scrape(options: ScraperOptions): Promise<ScrapeResult> {
    // 1. Loguearse en el portal
    // 2. Navegar a movimientos/saldos
    // 3. Extraer datos
    // 4. Devolver ScrapeResult
  },
};

export default scraper;
```

### Flujo recomendado

1. **Correr en modo headful** (`--headful`) para ver el login y navegación
2. **Usar `--screenshots`** para capturar el DOM en cada paso
3. **Analizar el HTML guardado** en `debug/` para identificar selectores
4. **Usar las utilidades** de `utils.ts` siempre que sea posible
5. **Manejar 2FA** — detectarlo y esperar, no intentar bypassear
6. **Probar con cuenta real** antes de abrir el PR

### Consideraciones importantes

- Los bancos chilenos usan **SPAs** (Angular/React) — no confiar en URLs, navegar por clicks
- Muchos tienen **popups post-login** (ofertas, encuestas) — cerrarlos con `closePopups()`
- Algunos requieren **2FA** (Santander, BCI, Itaú, BChile) — el scraper debe esperar la aprobación manual, retornando error claro si expira
- **Delays generosos** (2-4s) entre acciones — los portales bancarios son lentos
- **Selectores con fallback** — los bancos cambian el HTML, usar arrays de selectores
- **User-Agent** de Chrome reciente siempre

---

## 8. ⚠️ Troubleshooting común

| Problema | Causa | Solución |
|----------|-------|----------|
| "Chrome not found" | Puppeteer no encuentra Chrome | Instalar Chrome o `CHROME_PATH=/usr/bin/chromium-browser` |
| 2FA aparece | Banco pide clave dinámica | Aprobarlo manualmente, el scraper espera hasta 180s |
| 0 movimientos | Selector incorrecto o página no cargó | Usar `--screenshots` para ver qué muestra |
| Login falla | RUT o clave incorrectos | Verificar en el navegador manualmente |
| "No se encontró campo RUT" | El banco cambió su login | Revisar HTML con `--screenshots` |
| BancoEstado no funciona | Bloquea headless (TLS fingerprinting) | Usar `xvfb-run` en servidores, o `--headful` en desktop |
| Cencosud pide CAPTCHA | hCaptcha intermitente | Usar `--headful` para resolverlo manualmente |

### BancoEstado + Xvfb

```bash
# En servidores Linux sin GUI:
sudo apt install xvfb
xvfb-run node dist/cli.js --bank bestado --pretty
```

---

## 9. 🤖 Revisión de seguridad en PRs (DeepSeek)

Cada Pull Request es analizado automáticamente por DeepSeek para detectar:

| Amenaza | Ejemplo |
|---------|---------|
| 🔑 Credenciales hardcodeadas | `password="real"`, `api_key=...`, RUTs reales |
| 🐚 Malware / ofuscación | `eval()`, base64 sospechoso, conexiones a IPs externas |
| 🌐 Exfiltración de datos | Envío de datos a servidores no autorizados |
| 🐚 Command injection | `exec()`, `shell=True` |

**La IA no reemplaza pruebas humanas.** Solo es un filtro de seguridad. Los scrapers nuevos requieren 2 revisores con cuenta en ese banco que prueben el código.

---

## 10. 🤝 Modelo comunitario

```
PR abierto
  │
  ▼
🤖 AI Security Review (DeepSeek)
  │  Revisa: credenciales, malware, exfiltración
  │  NO reemplaza pruebas reales
  │
  ▼
👥 Revisión por pares
  │  ┌ Scraper nuevo → 2 revisores con cuenta en ese banco
  │  ┌ Mejora       → 1 revisor con cuenta
  │  ┌ Docs/CI      → 1 revisor
  │
  ▼
✅ Merge por mantenedor
```

- **Contribuidor:** cualquiera que abre un PR
- **Revisor:** miembro que prueba PRs con su cuenta real
- **Mantenedor:** revisor con permisos de merge

---

## 11. 🔒 Reglas de seguridad (importante)

- **NUNCA** incluir credenciales reales en commits
- **NUNCA** enviar datos a servidores externos
- **NUNCA** guardar credenciales en disco (solo env vars)
- **NUNCA** subir `.env` a git (está en `.gitignore`)
- **NUNCA** compartir screenshots con datos bancarios visibles
- Los screenshots de debug se guardan en `./screenshots/` (en `.gitignore`)
- Reportar vulnerabilidades por Issue con tag `security`

---

## 🧪 Tests

### Unitarios (Vitest)

```bash
npm test                    # ejecutar todos
npm run test:watch          # modo watch (desarrollo)
```

Cubren funciones de parsing, normalización y lógica de scrapers:

| Archivo | Lo que testea |
|---------|---------------|
| `src/utils.test.ts` | `DebugLog`, `deduplicateMovements` |
| `src/banks/bci.test.ts` | `normalizeBciApiMovements` (parsing de movimientos BCI) |
| `src/banks/santander.test.ts` | `normalizeSantanderApiMovements` (parsing Santander) |
| `src/intercept.test.ts` | Sistema de intercepción de requests |

**No hay tests de integración** (no se puede simular un banco real). Los scrapers se prueban manualmente con cuentas reales.

### Manuales (`test/`)

```bash
node test/falabella.mjs     # Prueba manual del scraper Falabella
node test/bchile.mjs        # Prueba manual del scraper BCHILE
```

Estos scripts requieren credenciales reales y Chrome. Se usan para verificar que el scraper funciona antes de abrir un PR.

### CI

Actualmente **no hay CI de tests** (los tests unitarios se ejecutan localmente). Pendiente agregar GitHub Action que corra `npm test` en cada PR.

---

## 12. 📄 Licencia

MIT — Copyright original del proyecto open-banking-chile.

Hecho en Chile 🇨🇱
