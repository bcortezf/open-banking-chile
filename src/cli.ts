#!/usr/bin/env node

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// Auto-load .env file
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "..", ".env");
if (existsSync(envPath)) {
  const lines = readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}

import { banks, listBanks, getBank } from "./index.js";

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--") || a.startsWith("-")));

  if (flags.has("--help") || flags.has("-h")) {
    const bankList = listBanks()
      .map((b) => `  ${b.id.padEnd(15)} ${b.name}`)
      .join("\n");

    console.log(`
open-banking-chile — Obtén tus movimientos bancarios como JSON

Uso:
  open-banking-chile --bank <banco> [opciones]

Bancos disponibles:
${bankList}

Opciones:
  --bank <id>         Banco a consultar (requerido)
  --list              Listar bancos disponibles
  --screenshots       Guardar screenshots en ./screenshots/
  --headful           Abrir Chrome visible (para debugging)
  --pretty            Formatear JSON con indentación
  --movements         Solo imprimir movimientos (sin metadata)
  --owner <T|A|B>     Filtro Titular/Adicional para TC (default: B = todos)
  --scope <tipo>      Alcance: personal | business | business:RUT (ej: business:77967769-9)
  --cuentas           [EMPRESAS/PERSONAS] Listar cuentas con saldo (sin movimientos)
  --beneficiarios     [EMPRESAS] Listar todos los beneficiarios de la agenda TEF
  --add-beneficiario  [EMPRESAS] Agregar beneficiario/cuenta en el portal
  --validar-cuenta    [EMPRESAS] Verificar si RUT+cuenta está en la agenda TEF
  --transferir        [EMPRESAS] Transferencia express (requiere Mi Pass)
  --monto <n>                   Monto a transferir (con --transferir)
  --beneficiario-rut <rut>      RUT del beneficiario
  --beneficiario-nombre <n>     Nombre del beneficiario
  --beneficiario-banco <b>      Banco (ej: "BANCO DEL ESTADO DE CHILE")
  --beneficiario-cuenta <n>     Número de cuenta
  --beneficiario-tipo <t>       Tipo: "Cuenta Corriente" | "Cuenta Vista" (default: Cuenta Corriente)
  --validar-rut <rut>           RUT a validar (con --validar-cuenta)
  --validar-numero <n>          Número de cuenta a validar
  --help, -h          Mostrar esta ayuda

Variables de entorno:
  <BANCO>_RUT      Tu RUT (ej: FALABELLA_RUT=12345678-9)
  <BANCO>_PASS     Tu clave de internet (ej: FALABELLA_PASS=miclave)
  CHROME_PATH      Ruta al ejecutable de Chrome/Chromium (opcional)
  BROWSER_URL      Conectar a Chrome ya abierto (ej: http://127.0.0.1:9222)
  BROWSER_WS_ENDPOINT  Endpoint WebSocket CDP (alternativa a BROWSER_URL)

Ejemplos:
  # Banco Falabella
  FALABELLA_RUT=12345678-9 FALABELLA_PASS=miclave open-banking-chile --bank falabella --pretty

  # Banco Chile Empresas (empresa específica por RUT)
  BCHILE_RUT=12345678-9 BCHILE_PASS=miclave open-banking-chile --bank bchile --empresa --bankQuery=77123456-1 --pretty

  # Listar bancos disponibles
  open-banking-chile --list

  # Solo movimientos, pipe a jq
  open-banking-chile --bank falabella --movements | jq '.[].description'
`);
    process.exit(0);
  }

  if (flags.has("--list")) {
    console.log("\nBancos disponibles:\n");
    for (const b of listBanks()) {
      console.log(`  ${b.id.padEnd(15)} ${b.name.padEnd(25)} ${b.url}`);
    }
    console.log(`\nTotal: ${listBanks().length} banco(s)`);
    console.log("¿Tu banco no está? ¡Contribuye! Ver CONTRIBUTING.md\n");
    process.exit(0);
  }

  // Parse --bank flag
  const bankIdx = args.indexOf("--bank");
  const bankId = bankIdx >= 0 ? args[bankIdx + 1] : undefined;

  if (!bankId) {
    const available = Object.keys(banks).join(", ");
    console.error(
      `Error: Debes especificar un banco con --bank <id>\n` +
      `Bancos disponibles: ${available}\n` +
      `Usa --list para más detalles o --help para ayuda.`
    );
    process.exit(1);
  }

  const bank = getBank(bankId);
  if (!bank) {
    const available = Object.keys(banks).join(", ");
    console.error(
      `Error: Banco "${bankId}" no encontrado.\n` +
      `Bancos disponibles: ${available}\n` +
      `Usa --list para más detalles.`
    );
    process.exit(1);
  }

  // Get credentials from env
  const prefix = bankId.toUpperCase();
  const rut = process.env[`${prefix}_RUT`];
  const password = process.env[`${prefix}_PASS`];

  if (!rut || !password) {
    console.error(
      `Error: Se requieren las variables ${prefix}_RUT y ${prefix}_PASS\n` +
      `Ejemplo: ${prefix}_RUT=12345678-9 ${prefix}_PASS=miclave open-banking-chile --bank ${bankId}\n` +
      `O copia .env.example a .env y rellena tus datos.`
    );
    process.exit(1);
  }

  if (flags.has("--screenshots")) {
    console.warn(
      "⚠️  --screenshots guarda imágenes y HTML con datos bancarios en ./screenshots/ y ./debug/\n" +
      "   No compartas estos archivos ni los subas a git."
    );
  }

  // Parse --owner flag
  const ownerIdx = args.indexOf("--owner");
  const ownerVal = ownerIdx >= 0 ? args[ownerIdx + 1]?.toUpperCase() : undefined;
  const owner = ownerVal === "T" || ownerVal === "A" || ownerVal === "B" ? ownerVal : undefined;

  // Parse --scope flag (replaces --empresa and --bankQuery)
  let scope: { type: "personal" | "business"; companyRut?: string } | undefined;
  const scopeArg = args.find((a) => a === "--scope" || a.startsWith("--scope="));
  if (scopeArg) {
    let rawScope: string;
    if (scopeArg.startsWith("--scope=")) {
      rawScope = scopeArg.split("=")[1];
    } else {
      rawScope = args[args.indexOf(scopeArg) + 1] || "";
    }
    if (rawScope === "personal") {
      scope = { type: "personal" };
    } else if (rawScope === "business") {
      scope = { type: "business" };
    } else if (rawScope.startsWith("business:")) {
      scope = { type: "business", companyRut: rawScope.slice(9) };
    }
  }
  // Fallback: compatibilidad con --empresa / --bankQuery (deprecated)
  if (!scope) {
    const empresaMode = flags.has("--empresa");
    let bankQuery: string | undefined;
    const bankQueryArg = args.find((a) => a === "--bankQuery" || a.startsWith("--bankQuery="));
    if (bankQueryArg) {
      const val = bankQueryArg.includes("=") ? bankQueryArg.split("=")[1] : args[args.indexOf(bankQueryArg) + 1];
      bankQuery = val?.trim() || undefined;
    }
    if (empresaMode || bankQuery) {
      scope = { type: "business", ...(bankQuery && { companyRut: bankQuery }) };
    }
  }

  // Parse acciones: --cuentas | --beneficiarios | --add-beneficiario | --validar-cuenta | --transferir
  let action: "listar-cuentas" | "listar-beneficiarios" | "agregar-beneficiario" | "validar-cuenta" | "transferencia-express" | undefined;
  if (flags.has("--cuentas")) {
    action = "listar-cuentas";
  } else if (flags.has("--beneficiarios")) {
    action = "listar-beneficiarios";
  } else if (flags.has("--add-beneficiario")) {
    action = "agregar-beneficiario";
  } else if (flags.has("--validar-cuenta")) {
    action = "validar-cuenta";
  } else if (flags.has("--transferir")) {
    action = "transferencia-express";
  }

  // Parse datos del beneficiario (--add-beneficiario)
  const valorFlag = (flag: string): string | undefined => {
    const arg = args.find((a) => a === flag || a.startsWith(`${flag}=`));
    if (!arg) return undefined;
    return arg.includes("=") ? arg.split("=")[1] : args[args.indexOf(arg) + 1]?.trim();
  };
  const beneficiario = action === "agregar-beneficiario" ? {
    rutBeneficiario: valorFlag("--beneficiario-rut") ?? "",
    nombreBeneficiario: valorFlag("--beneficiario-nombre") ?? "",
    banco: valorFlag("--beneficiario-banco") ?? "",
    numeroCuenta: valorFlag("--beneficiario-cuenta") ?? "",
    tipoCuenta: valorFlag("--beneficiario-tipo") ?? "Cuenta Corriente",
  } : undefined;

  const validar = action === "validar-cuenta" ? {
    rutBeneficiario: valorFlag("--validar-rut") ?? valorFlag("--beneficiario-rut") ?? "",
    numeroCuenta: valorFlag("--validar-numero") ?? valorFlag("--beneficiario-cuenta") ?? "",
  } : undefined;

  const montoRaw = valorFlag("--monto");
  const transferencia = action === "transferencia-express" ? {
    monto: montoRaw ? Number(montoRaw) : 0,
    rutBeneficiario: valorFlag("--beneficiario-rut") ?? "",
    numeroCuenta: valorFlag("--beneficiario-cuenta") ?? "",
    bankName: valorFlag("--beneficiario-banco"),
  } : undefined;

  const result = await bank.scrape({
    rut,
    password,
    chromePath: process.env.CHROME_PATH,
    browserURL: process.env.BROWSER_URL || undefined,
    browserWSEndpoint: process.env.BROWSER_WS_ENDPOINT || undefined,
    saveScreenshots: flags.has("--screenshots"),
    headful: flags.has("--headful"),
    ...(owner && { owner }),
    ...(scope && { scope }),
    ...(action && { action }),
    ...(beneficiario && { beneficiario }),
    ...(validar && { validar }),
    ...(transferencia && { transferencia }),
  });

  if (!result.success) {
    console.error(`Error: ${result.error}`);
    if (result.debug) {
      console.error("\nDebug log:");
      console.error(result.debug);
    }
    process.exit(1);
  }

  const indent = flags.has("--pretty") ? 2 : undefined;

  if (flags.has("--movements")) {
    console.log(JSON.stringify(result.movements, null, indent));
  } else if (flags.has("--cuentas") && result.cuentas) {
    console.log(JSON.stringify(result.cuentas, null, indent));
  } else {
    const { screenshot: _, ...output } = result;
    console.log(JSON.stringify(output, null, indent));
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
