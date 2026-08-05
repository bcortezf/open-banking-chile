# 🔒 Política de Seguridad

## Reportar una vulnerabilidad

Si encuentras una vulnerabilidad de seguridad en este proyecto:

1. **No abras un Issue público** (para vulnerabilidades críticas)
2. Envía un mensaje privado a un mantenedor
3. Alternativamente, abre un Issue con tag `security` (para issues no críticos)

## Lo que NO debe aparecer en este repo

| Elemento | Acción |
|----------|--------|
| `.env` con credenciales reales | ❌ Bloqueado por `.gitignore` + AI Review |
| RUTs, passwords o tokens en código | ❌ Detectado por AI Review |
| Screenshots con datos bancarios visibles | ❌ No subir al repo |
| Movimientos de terceros sin consentimiento | ❌ Violación de datos personales |

## Lo que SÍ es seguro

- ✅ Tu RUT y clave **nunca salen de tu máquina** (todo es local)
- ✅ El proyecto no tiene telemetría ni tracking
- ✅ No hay servidores externos — todo corre en tu PC
- ✅ Los datos no se almacenan en ningún lado (a menos que uses la app finapp)

## Proceso de revisión de seguridad

Cada Pull Request pasa por:

1. **🤖 AI Review automático** (DeepSeek) — detecta credenciales, malware, exfiltración
2. **🧪 CI automático** — `npm test` (unitarios con mocks) + `npm run build` en cada PR
3. **🏦 E2E con cuenta bancaria real** — SOLO tras aprobación manual de un mantenedor (Environment `e2e`)
4. **👀 Revisión humana** — miembros de la comunidad revisan el código

Si la IA detecta algo sospechoso, el PR se marca con `⚠️ Security Review` y un mantenedor revisa manualmente.

## 🔐 Credenciales bancarias en CI (GitHub Secrets)

El flujo E2E usa **credenciales bancarias reales** que viven como **GitHub Secrets** del repo:

- 🔒 **Solo el admin** puede ver/editar los secrets (Settings → Secrets and variables → Actions)
- 🕵️ Los mantenedores ven el *nombre* del secret pero **nunca su valor**
- 🚦 El workflow `e2e.yml` usa el **Environment "e2e"** con *required reviewers*: el runner **ni arranca** hasta que un mantenedor aprueba el deployment
- 🧾 GitHub enmascara automáticamente los valores en los logs (nunca se imprimen)
- ⏱️ El test E2E incluye un test que **verifica que las credenciales no aparezcan en el output**

### Secrets necesarios

| Secret | Banco | Ejemplo |
|--------|-------|---------|
| `BCHILE_RUT` | Banco de Chile | `20020177-9` |
| `BCHILE_PASS` | Banco de Chile | `tu_clave` |
| `FALABELLA_RUT` | Banco Falabella | `12345678-9` |
| `FALABELLA_PASS` | Banco Falabella | `tu_clave` |
| `DEEPSEEK_API_KEY` | AI Review | `sk-...` |

> Si falta el secret de un banco, ese suite E2E se skipea. Para agregar más bancos: secrets + entrada en `E2E_BANKS` / `src/e2e.test.ts`.

### Flujo de aprobación

```
PR abierto → CI básico + AI Review (auto)
     ↓
Mantenedor revisa el código
     ↓
Aprueba el Environment "e2e" (botón "Review deployments")
     ↓
Corren los tests E2E con credenciales reales
```

## Buenas prácticas

```bash
# Nunca subir .env a git
echo ".env" >> .gitignore

# Permisos seguros para .env
chmod 600 .env

# No compartir screenshots con datos sensibles
# Usar --screenshots solo para debug local
```
