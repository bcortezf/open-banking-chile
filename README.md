# 🏦 Open Banking Chile

[![Licencia MIT](https://img.shields.io/badge/Licencia-MIT-green.svg)](LICENSE)
[![PRs](https://img.shields.io/badge/PRs-bienvenidos-brightgreen.svg)](CONTRIBUTING.md)
[![AI Review](https://img.shields.io/badge/AI%20Review-DeepSeek-blueviolet)](.github/workflows/ai-pr-review.yml)
[![Bancos](https://img.shields.io/badge/bancos-11-blue)](README.md)
[![Hecho en Chile](https://img.shields.io/badge/Hecho_en-Chile-red?logo=chile)](https://chile)

> **Fork comunitario** — Scrapers open source para bancos chilenos.
> Obtén tus movimientos bancarios y saldo como JSON limpio.
>
> 🔄 Mantenido por la comunidad. Fork del proyecto original open-banking-chile (MIT).

**Disclaimer:** Este proyecto no está afiliado con ningún banco. Úsalo bajo tu propia responsabilidad y solo con tus propias credenciales.

---

## 🏛️ Modelo comunitario

Este proyecto opera con **revisión por pares**. Cada cambio debe ser probado y aprobado por miembros de la comunidad.

| Rol | Descripción |
|-----|------------|
| 🤝 **Contribuidor** | Abre PRs con scrapers nuevos o mejoras |
| 👀 **Revisor** | Prueba PRs con sus propias cuentas bancarias |
| 🛡️ **Mantenedor** | Revisores con permisos de merge |

📖 **[Guía completa de la comunidad](COMMUNITY.md)** · **[Cómo contribuir](CONTRIBUTING.md)** · **[Política de seguridad](SECURITY.md)**

---

## 🏦 Bancos soportados

| Banco | ID | Estado |
|-------|----|--------|
| Banco Falabella (cuenta + CMR TC) | `falabella` | ✅ |
| Banco BICE | `bice` | ✅ |
| Santander | `santander` | ✅ |
| Banco Edwards | `edwards` | ✅ |
| Scotiabank | `scotiabank` | ✅ |
| Banco de Chile (personas + empresas) | `bchile` | ✅ |
| BCI | `bci` | ✅ |
| Itaú | `itau` | ✅ |
| Banco Estado (CuentaRUT) | `bestado` | ✅ |
| Tarjeta Cencosud | `cencosud` | ✅ |
| Banco Security | `bancosecurity` | ✅ |

**¿Tu banco no está?** → [Agrégalo](CONTRIBUTING.md) — necesitas una cuenta real para probarlo.

---

## ⚡ Instalación

```bash
git clone https://github.com/bcortezf/open-banking-chile.git
cd open-banking-chile
npm install && npm run build
cp .env.example .env   # edita con tus credenciales
```

**Requisitos:** Node.js >= 18, Google Chrome o Chromium.

```bash
# Instalar Chrome — Ubuntu/Debian
sudo apt update && sudo apt install -y google-chrome-stable

# macOS
brew install --cask google-chrome
```

> 💡 El CLI carga automáticamente las variables del `.env`, no necesitas hacer `source .env`.

---

## 🚀 Uso

### CLI

Configura tu `.env` con tus credenciales siguiendo el `.env.example`, luego:

```bash
# Consultar banco
node dist/cli.js --bank falabella --pretty

# Solo movimientos (fácil de pipear a jq)
node dist/cli.js --bank falabella --movements | jq .

# Listar bancos disponibles
node dist/cli.js --list

# Ayuda completa
node dist/cli.js --help

# Con screenshots para debugging
node dist/cli.js --bank falabella --screenshots --pretty

# Modo headful (Chrome visible, para debug visual)
node dist/cli.js --bank falabella --headful --pretty
```

**Opciones CLI:**

| Flag | Descripción |
|------|-------------|
| `--bank <id>` | Banco a consultar (requerido) |
| `--list` | Listar bancos disponibles |
| `--pretty` | JSON formateado con indentación |
| `--movements` | Solo array de movimientos (sin metadata) |
| `--screenshots` | Guardar screenshots en `./screenshots/` |
| `--headful` | Chrome visible (debugging). **BancoEstado siempre usa headful** |
| `--owner <T\|A\|B>` | Filtro Titular/Adicional para TC (default: B = todos) |
| `--empresa` | [BCHILE] Usar portal empresas |
| `--bankQuery <RUT>` | [BCHILE] RUT empresa a consultar |

### Como librería

```typescript
import { getBank } from "open-banking-chile";

const falabella = getBank("falabella");
const result = await falabella!.scrape({
  rut: "12345678-9",
  password: "mi_clave",
});

if (result.success) {
  console.log(`Banco: ${result.bank}`);

  // Cuentas
  for (const account of result.accounts ?? []) {
    console.log(`Saldo: $${account.balance?.toLocaleString("es-CL")}`);
    for (const m of account.movements) {
      const sign = m.amount > 0 ? "+" : "";
      console.log(`${m.date} | ${m.description.padEnd(40)} | ${sign}$${m.amount.toLocaleString("es-CL")}`);
    }
  }

  // Tarjetas de crédito
  for (const card of result.creditCards ?? []) {
    console.log(`\nTarjeta: ${card.label}`);
    for (const m of card.movements ?? []) {
      const sign = m.amount > 0 ? "+" : "";
      console.log(`${m.date} | ${m.description.padEnd(40)} | ${sign}$${m.amount.toLocaleString("es-CL")} [${m.source}]`);
    }
  }
}
```

### Output de ejemplo

```json
{
  "success": true,
  "bank": "falabella",
  "accounts": [
    {
      "balance": 1250000,
      "movements": [
        {
          "date": "08-03-2026",
          "description": "COMPRA SUPERMERCADO LIDER",
          "amount": -45230,
          "balance": 1250000,
          "source": "account"
        }
      ]
    }
  ],
  "creditCards": [
    {
      "label": "Visa Signature ****4585",
      "national": { "used": 2227324, "available": 3872676, "total": 6100000 },
      "international": { "used": 0, "available": 3001.24, "total": 3000, "currency": "USD" },
      "nextBillingDate": "21 de agosto",
      "billingPeriod": "Junio 2026",
      "movements": [
        {
          "date": "23-07-2026",
          "description": "DISNEY PLUS COMPRAS INT.VI",
          "amount": -17.14,
          "balance": 0,
          "source": "credit_card_unbilled",
          "installments": "01/01"
        },
        {
          "date": "30-06-2026",
          "description": "PAGO PESOS TEF PAGO NORMAL",
          "amount": 2500000,
          "balance": 0,
          "source": "credit_card_unbilled",
          "installments": "01/01"
        }
      ]
    }
  ]
}
```

### Campo `source`

Cada movimiento incluye `source` indicando su origen:

| Valor | Descripción |
|-------|-------------|
| `account` | Cuenta corriente o vista |
| `credit_card_unbilled` | Tarjeta de crédito — por facturar |
| `credit_card_billed` | Tarjeta de crédito — facturado |

**Campos opcionales en `BankMovement`:**

| Campo | Descripción |
|-------|-------------|
| `owner` | `"titular"` o `"adicional"` |
| `card` | Máscara de la tarjeta, ej: `"****8335"` |
| `installments` | Cuotas formato `NN/NN`, ej: `"02/06"` |
| `totalAmount` | Monto total de la compra en cuotas |

---

## 🏗️ Estructura del proyecto

```
src/
  index.ts              — Registro de bancos, getBank(), listBanks()
  types.ts              — Interfaces: BankScraper, BankMovement, ScrapeResult
  utils.ts              — Utilidades compartidas (ver abajo)
  cli.ts                — CLI entry point
  banks/
    falabella.ts        — Banco Falabella + CMR
    bestado.ts          — Banco Estado (CuentaRUT, requiere headful)
    bchile.ts           — Banco de Chile (personas + empresas, REST API)
    bci.ts              — BCI (iframes)
    bice.ts             — Banco BICE
    cencosud.ts         — Tarjeta Cencosud (hCaptcha ocasional)
    edwards.ts          — Banco Edwards
    itau.ts             — Itaú
    santander.ts        — Banco Santander
    scotiabank.ts       — Scotiabank Chile
    bancosecurity.ts    — Banco Security
```

### Utilidades compartidas (`utils.ts`)

| Función | Descripción |
|---------|-------------|
| `parseChileanAmount(text)` | Parsea montos en formato chileno ($1.234.567) a número |
| `normalizeDate(raw)` | Normaliza fechas a DD-MM-YYYY |
| `normalizeOwner(raw)` | Normaliza owner a `"titular"` o `"adicional"` |
| `normalizeInstallments(raw)` | Normaliza cuotas a formato NN/NN |
| `deduplicateMovements(movements)` | Elimina movimientos duplicados |
| `logout(page, debugLog)` | Cierra sesión automáticamente |
| `formatRut(rut)` | Formatea RUT (12345678-9 → 12.345.678-9) |
| `findChrome()` | Busca Chrome/Chromium en el sistema |
| `closePopups(page)` | Cierra popups y modales genéricos |
| `delay(ms)` | Espera N milisegundos |
| `saveScreenshot(page, name, enabled, debugLog)` | Guarda screenshot si está habilitado |

---

## 🤖 Revisión IA de PRs

Cada Pull Request es analizado automáticamente por **DeepSeek** para detectar:

| Amenaza | Detección |
|---------|-----------|
| 🔑 Credenciales hardcodeadas | ✅ |
| 🐚 Command injection | ✅ |
| 🕵️ Código ofuscado / malware | ✅ |
| 🌐 Exfiltración de datos | ✅ |

La IA **no reemplaza** las pruebas con cuentas reales. Solo es un filtro de seguridad automatizado.

---

## 🔒 Seguridad

- **Tus credenciales nunca salen de tu máquina.** Todo corre 100% local.
- No hay analytics, telemetría, ni tracking.
- Las credenciales se pasan por env vars, nunca se guardan en disco.
- Los screenshots de debug pueden contener datos sensibles — no los compartas.
- Cada PR es analizado por IA (DeepSeek) para detectar código malicioso.

---

## 🔄 Automatización (cron)

```bash
# Sincronizar Falabella diariamente a las 7 AM
0 7 * * * cd ~/open-banking-chile && node dist/cli.js --bank falabella --pretty >> /var/log/bank-sync.log 2>&1

# Sincronizar BICE con 3 meses históricos
0 7 * * * cd ~/open-banking-chile && BICE_MONTHS=3 node dist/cli.js --bank bice >> /var/log/bank-sync.log 2>&1

# Sincronizar todos los bancos (usando el script)
0 8 * * * cd ~/open-banking-chile && bash finapp/scripts/daily.sh >> data/sync.log 2>&1
```

---

## ⚠️ Troubleshooting

| Problema | Solución |
|----------|----------|
| Chrome no encontrado | Instala Chrome o usa `CHROME_PATH=/ruta/chrome` |
| 2FA / Clave dinámica | Apruébalo manualmente en tu banco y vuelve a intentar |
| 0 movimientos | Usa `--screenshots --pretty` y revisa el debug log |
| Login falla | Verifica RUT y clave, prueba con `--headful` |
| BancoEstado bloqueado | Usa `xvfb-run` en servidores sin GUI (ver abajo) |
| Cencosud pide CAPTCHA | Reintenta con `--headful` para resolverlo manualmente |

### BancoEstado y modo headless

BancoEstado detecta navegadores headless a nivel de red (TLS fingerprinting). El scraper siempre corre en modo headful.

**En servidores Linux sin GUI**, usa Xvfb:

```bash
# Instalar
sudo apt install xvfb

# Correr
xvfb-run node dist/cli.js --bank bestado --pretty
```

**En Mac/Windows** no necesitas nada extra — Chrome se abre y cierra automáticamente.

### Tarjeta Cencosud y CAPTCHA

Cencosud presenta ocasionalmente un hCaptcha en el login:

- **Headless** (default): detecta el CAPTCHA y retorna error claro.
- **Headful** (`--headful`): pausa y espera a que resuelvas el CAPTCHA manualmente.

```bash
node dist/cli.js --bank cencosud --headful --pretty
```

Timeout configurable: `CENCOSUD_CAPTCHA_TIMEOUT=segundos`.

---

## 🤝 Contribuir

Queremos cubrir **todos los bancos de Chile**. Si tienes cuenta en un banco que falta:

1. Lee [CONTRIBUTING.md](CONTRIBUTING.md) para la guía paso a paso
2. Crea `src/banks/<tu-banco>.ts` implementando `BankScraper`
3. Usa las utilidades compartidas de `utils.ts`
4. Regístralo en `src/index.ts`
5. Abre un PR — necesitas 2 revisores con cuenta en ese banco

---

## 📄 Licencia

MIT — manteniendo el copyright original del proyecto open-banking-chile.

Hecho en Chile 🇨🇱
