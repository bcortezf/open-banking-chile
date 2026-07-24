---

name: "\U0001F9D1‍\U0001F4BB Nuevo scraper / Feature"
about: Agrega un scraper de banco o mejora uno existente
title: "feat: [Banco] - descripción breve"

---

## ¿Qué banco o feature?

**Banco:** [ej: Banco Ripley / Banco Internacional / etc.]
**Tipo:** [ ] Nuevo scraper | [ ] Mejora a scraper existente | [ ] Infraestructura

---

## Evidencia de funcionamiento

<!-- Adjunta output del scraper funcionando (datos sensibles sanitizados con ***) -->

```
PEGA AQUÍ EL OUTPUT JSON (reemplaza montos sensibles con ***)
```

O screenshot:

---

## Testing checklist

- [ ] Probé el scraper con mi cuenta real del banco
- [ ] Login exitoso
- [ ] Se obtuvieron movimientos correctamente
- [ ] El saldo mostrado es el esperado
- [ ] No incluí archivos `.env` ni credenciales en el PR
- [ ] No hay datos personales míos ni de terceros en el diff

---

## ¿Cómo probarlo?

```bash
export MI_BANCO_RUT=12345678-9
export MI_BANCO_PASS=***
node dist/cli.js --bank mi-banco --pretty
```

---

## Información adicional

<!-- Cualquier detalle relevante: URLs del portal, tipo de login, 2FA, etc. -->
