import type { AgendaBeneficiario } from "../types.js";

/** Normaliza RUT para comparar agenda: sin puntos/espacios, mayúsculas. */
export function normalizeRutAgenda(rut: string | null | undefined): string {
  if (!rut || typeof rut !== "string") return "";
  return rut.replace(/\s/g, "").replace(/\./g, "").toUpperCase().trim();
}

/** Normaliza número de cuenta: solo dígitos. */
export function normalizeNumeroCuenta(num: unknown): string {
  if (num == null) return "";
  return String(num).replace(/\s/g, "").replace(/-/g, "").replace(/\D/g, "");
}

/**
 * Busca un beneficiario por RUT + número de cuenta (últimos dígitos también coinciden).
 */
export function findBeneficiarioEnAgenda(
  lista: AgendaBeneficiario[],
  rut: string,
  numeroCuenta: string
): AgendaBeneficiario | null {
  const r = normalizeRutAgenda(rut);
  const n = normalizeNumeroCuenta(numeroCuenta);
  if (!r || !n) return null;

  for (const b of lista) {
    const br = normalizeRutAgenda(String(b.rutBeneficiario ?? b.rut ?? ""));
    const bn = normalizeNumeroCuenta(b.numeroCuenta ?? b.cuenta ?? b.id);
    if (br === r && (bn === n || bn.endsWith(n) || n.endsWith(bn))) {
      return b;
    }
  }
  return null;
}

/** Extrae array de beneficiarios desde la respuesta de tef-agenda/agenda/filtro. */
export function parseAgendaResponse(data: unknown): AgendaBeneficiario[] {
  if (Array.isArray(data)) {
    return data as AgendaBeneficiario[];
  }
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    if (Array.isArray(d.listaBeneficiarios)) {
      return d.listaBeneficiarios as AgendaBeneficiario[];
    }
    if (Array.isArray(d.destinatarios)) {
      return d.destinatarios as AgendaBeneficiario[];
    }
    for (const v of Object.values(d)) {
      if (Array.isArray(v)) return v as AgendaBeneficiario[];
    }
  }
  return [];
}
