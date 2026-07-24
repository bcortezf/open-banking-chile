# Contribuyendo a Open Banking Chile

¡Gracias por querer contribuir! Este es un proyecto comunitario donde todos los PRs pasan por revisión de pares.

---

## 🧭 Flujo de contribución

```
1. Idea / Bug → Issue
       ↓
2. Fork + Branch
       ↓
3. Código + pruebas locales
       ↓
4. PR con plantilla
       ↓
5. 🤖 AI Security Review (automático)
       ↓
6. 👥 Revisión por pares (community)
       ↓
7. ✅ Merge por mantenedor
```

---

## 🏗️ ¿Qué puedes contribuir?

| Tipo | Dificultad | Revisión requerida |
|------|-----------|-------------------|
| **Scraper nuevo** (banco nuevo) | Media-Alta | 2 revisores con cuenta en ese banco |
| **Mejora a scraper existente** | Media | 1 revisor con cuenta en ese banco |
| **Utilidades compartidas** (utils.ts) | Baja-Media | 1 revisor |
| **Bug fix** | Baja | 1 revisor |
| **Documentación** | Baja | 1 revisor |
| **CI / Infraestructura** | Media | 1 revisor |

---

## 🆕 Agregar un nuevo banco

### 1. Requisitos previos

- Tener cuenta en el banco que quieres agregar
- Node.js >= 18
- Google Chrome o Chromium
- Haber leído `COMMUNITY.md` (proceso de revisión)

### 2. Crear el scraper

```bash
# 1. Forkear el repo
# 2. Clonar tu fork
git clone https://github.com/tu-usuario/open-banking-chile.git
cd open-banking-chile
npm install

# 3. Crear el scraper
cp src/banks/falabella.ts src/banks/mi-banco.ts
# 4. Implementar la interfaz BankScraper
# 5. Registrarlo en src/index.ts
```

### 3. Implementación

```typescript
// src/banks/mi-banco.ts
import type { BankScraper, ScrapeResult, ScraperOptions } from "../types.js";

const scraper: BankScraper = {
  id: "mi-banco",
  name: "Mi Banco",
  url: "https://www.mibanco.cl",
  async scrape(options: ScraperOptions): Promise<ScrapeResult> {
    // Tu implementación aquí
  },
};

export default scraper;
```

**Tips de implementación:**
- Usa las utilidades compartidas de `src/utils.ts` (`parseChileanAmount`, `normalizeDate`, etc.)
- Sigue el patrón de los scrapers existentes (login → navegar → extraer)
- Usa `saveScreenshot` para debugging
- Maneja 2FA si el banco lo requiere (ver Santander, Itaú, BCI como ejemplos)

### 4. Registrarlo

```typescript
// src/index.ts
import miBanco from "./banks/mi-banco.js";

export const banks: Record<string, BankScraper> = {
  // ... bancos existentes
  "mi-banco": miBanco,
};
```

### 5. Probar localmente

```bash
npm run build
MI_BANCO_RUT=12345678-9 MI_BANCO_PASS=tu_clave node dist/cli.js --bank mi-banco --pretty
```

### 6. Abrir el PR

Usa la plantilla de PR e incluye:
- Output del scraper funcionando (montos sensibles con ***)
- Checklist de testing marcada
- Menciona que tienes cuenta en ese banco

---

## 🧪 Cómo probar PRs de otros

Cuando alguien abre un PR con un scraper nuevo:

```bash
# 1. Hacer fetch del branch del PR
git fetch origin pull/ID/head:pr-nuevo-banco
git checkout pr-nuevo-banco

# 2. Compilar y probar
npm install
npm run build

# 3. Ejecutar con tu cuenta
MI_BANCO_RUT=tu_rut MI_BANCO_PASS=tu_clave node dist/cli.js --bank mi-banco --pretty

# 4. Si funciona, dejar approve en el PR:
#    "✅ Probado con mi cuenta. Login OK, movimientos correctos, saldo coincide."
```

---

## 📝 Guía de estilo

- TypeScript, tipado estricto
- Nombres en inglés para funciones/variables, descripciones en español donde aplique
- Usar `async/await`, evitar callbacks
- Manejar errores con try/catch y logging descriptivo
- No usar `any` — siempre tipar
- Seguir el formato de los scrapers existentes

---

## 🔒 Política de seguridad

**NUNCA incluir en un PR:**
- Archivos `.env`
- Credenciales reales (RUT, passwords, tokens)
- Screenshots con datos financieros visibles
- Movimientos bancarios de terceros sin su consentimiento

**Reportar vulnerabilidades:** Abrir un Issue con tag `security` o escribir a un mantenedor directamente.

---

## ❓ Preguntas frecuentes

**¿Puedo agregar un banco sin tener cuenta?**
No. Necesitas una cuenta real para probar el scraper. Si no tienes cuenta, puedes ayudar revisando código o documentación.

**¿Cuánto tarda la revisión?**
Depende de la comunidad. Scrapers nuevos suelen tomar 1-7 días hasta que 2 personas con ese banco puedan probarlo.

**¿Qué pasa si un banco cambia su web y se rompe?**
Abrir un Issue con tag `bug`. Idealmente incluir screenshot del error.

**¿Puedo probar un PR sin tener cuenta en ese banco?**
Puedes revisar el código, pero la aprobación funcional requiere alguien con cuenta en ese banco.
