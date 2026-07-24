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
2. **👀 Revisión humana** — miembros de la comunidad revisan el código
3. **🧪 Prueba funcional** — con cuenta bancaria real (obligatorio para scrapers)

Si la IA detecta algo sospechoso, el PR se marca con `⚠️ Security Review` y un mantenedor revisa manualmente.

## Buenas prácticas

```bash
# Nunca subir .env a git
echo ".env" >> .gitignore

# Permisos seguros para .env
chmod 600 .env

# No compartir screenshots con datos sensibles
# Usar --screenshots solo para debug local
```
