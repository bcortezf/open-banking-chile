# 🏦 Open Banking Chile — Community Fork

**Repositorio comunitario de scrapers open source para bancos chilenos.**

Este fork nace del proyecto original open-banking-chile (MIT). El objetivo es mantener vivo el proyecto con la ayuda de la comunidad, bajo un proceso de revisión colaborativa.

---

## 🌐 ¿Qué es esto?

Scrapers para obtener tus movimientos bancarios y saldo como JSON, 100% local, sin servidores externos.

**Bancos soportados:**
✅ Banco Falabella · Banco BICE · Santander · Edwards · Scotiabank · Banco de Chile · BCI · Itaú · Banco Estado

---

## 🤝 Cómo funciona la comunidad

Este proyecto opera con **revisión por pares** — cada Pull Request debe ser probado y aprobado por miembros de la comunidad antes de mergear.

### Roles

| Rol | Responsabilidad |
|-----|----------------|
| **Contribuidor** | Cualquiera que abre un PR |
| **Revisor** | Miembro de la comunidad que prueba y aprueba PRs |
| **Mantenedor** | Revisores con permisos de merge (historial probado) |

### ¿Cómo convertirte en revisor?

1. Aprueba y prueba 3+ PRs de otros
2. Un mantenedor te agrega al equipo de revisores

---

## 📥 Pull Request Process

### Paso 1: Antes de abrir el PR

- [ ] Leíste el `CONTRIBUTING.md`
- [ ] Probaste localmente con tu banco y funciona
- [ ] No incluye archivos `.env`, credenciales, ni datos personales
- [ ] Los screenshots de prueba no tienen datos sensibles visibles

### Paso 2: Abrir el PR con la plantilla

Usa la plantilla de PR (se carga automáticamente). Incluye:

- **Banco / feature** que agregas
- **Evidencia de que funciona** (output JSON con datos sanitizados o screenshots)
- **Testing checklist** marcada

### Paso 3: Revisión automática (IA)

Un workflow de GitHub revisa tu PR automáticamente buscando:

- 🔑 Credenciales hardcodeadas
- 🐚 Command injection
- 🕵️ Código ofuscado o malicioso
- 🌐 Envío de datos a servidores externos no autorizados

Si la IA flaggea algo, el PR se marca con "⚠️ Security Review" y un mantenedor lo revisa manualmente antes de mergear.

### Paso 4: Revisión por pares

**Para scrapers nuevos de bancos:**

```
Se requieren mínimo 2 aprobaciones de miembros que tengan
cuenta en ese banco, con comentario confirmando:
"Probado con mi cuenta RUT *****-9 — funciona correctamente"
```

**Para cambios en scrapers existentes:**

```
Se requiere 1 aprobación de un revisor que tenga cuenta en
ese banco, más la revisión IA aprobada.
```

**Para cambios en infraestructura (CLI, CI, docs):**

```
Se requiere 1 aprobación de cualquier revisor.
```

### Paso 5: Merge

- Un mantenedor hace merge cuando:
  - ✅ IA review passed (o override manual por mantenedor)
  - ✅ Mínimo de aprobaciones cumplido
  - ✅ Sin conflictos

---

## 🧪 Testing de scrapers (guía)

Para probar un scraper de banco:

```bash
# 1. Configurar credenciales
export BANCO_RUT=12345678-9
export BANCO_PASS=tu_clave

# 2. Ejecutar el scraper
node dist/cli.js --bank <id> --pretty

# 3. Verificar
#    - ¿El login funciona?
#    - ¿Los movimientos se ven correctos?
#    - ¿El saldo es el esperado?

# 4. Dejar comentario en el PR
```

**Tips:**
- Usa `--screenshots` si hay problemas de visualización
- Usa `--headful` para debuggear el login
- Los montos sensibles puedes ofuscarlos antes de compartir

---

## 🤖 Revisión IA (DeepSeek)

Cada PR ejecuta automáticamente un análisis de seguridad con DeepSeek.

**Lo que revisa:**

| Tipo | Qué detecta |
|------|------------|
| Credenciales | `password=`, `api_key=`, tokens, RUTs |
| Malware | Código ofuscado, eval(), conexiones a IPs externas |
| Exfiltración | POST/GET a servidores no autorizados |
| SQLi | Queries sin parametrizar |
| File access | Lectura de archivos fuera del proyecto |

**La IA NO reemplaza la revisión humana.** Solo es un filtro de seguridad automatizado. Las pruebas funcionales las hace la comunidad con cuentas reales.

---

## 🗳️ Toma de decisiones

- **Decisiones técnicas:** Se discuten en Issues/PRs, se resuelven por consenso
- **Decisiones controversiales:** Votación entre mantenedores (mayoría simple)
- **Code of Conduct:** Sea respetuoso. Esto es software libre chileno, no una guerra.

---

## 📄 Licencia

MIT — manteniendo el copyright original del proyecto open-banking-chile.
