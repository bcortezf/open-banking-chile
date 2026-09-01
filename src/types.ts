/** Origen del movimiento */
export const MOVEMENT_SOURCE = {
  account: "account",
  credit_card_unbilled: "credit_card_unbilled",
  credit_card_billed: "credit_card_billed",
} as const;

export type MovementSource = typeof MOVEMENT_SOURCE[keyof typeof MOVEMENT_SOURCE];

/** Titular de la tarjeta */
export const CARD_OWNER = {
  titular: "titular",
  adicional: "adicional",
} as const;

export type CardOwner = typeof CARD_OWNER[keyof typeof CARD_OWNER];

/** Un movimiento bancario individual */
export interface BankMovement {
  /** Fecha del movimiento (formato dd-mm-yyyy) */
  date: string;
  /** Descripción del movimiento (sin prefijos de origen) */
  description: string;
  /** Monto: positivo = abono (depósito), negativo = cargo (gasto) */
  amount: number;
  /** Saldo después del movimiento */
  balance: number;
  /** Origen: cuenta corriente, TC no facturada, TC facturada */
  source: MovementSource;
  /** Titular o adicional de la tarjeta */
  owner?: CardOwner;
  /** Identificador de la tarjeta (ej: "****8335") — útil cuando hay múltiples tarjetas */
  card?: string;
  /** Cuotas (ej: "01/01", "02/06") */
  installments?: string;
  /** Monto total de la compra (distinto de amount cuando es en cuotas) */
  totalAmount?: number;
}

/** Saldo y movimientos de una cuenta bancaria */
export interface AccountBalance {
  /** Identificador de la cuenta (ej: "Cuenta Corriente ****2706") */
  label?: string;
  /** Saldo actual */
  balance?: number;
  /** Movimientos de la cuenta */
  movements: BankMovement[];
}

/** Saldo de una tarjeta de crédito */
export interface CreditCardBalance {
  /** Etiqueta de la tarjeta (ej: "Mastercard Black ****5824") */
  label: string;
  /** Cupo nacional */
  national?: {
    used: number;
    available: number;
    total: number;
  };
  /** Cupo internacional */
  international?: {
    used: number;
    available: number;
    total: number;
    currency: string;
  };
  /** Periodo de facturación actual (ej: "Febrero 2026") */
  billingPeriod?: string;
  /** Próxima fecha de facturación (formato dd-mm-yyyy) */
  nextBillingDate?: string;
  /** Próxima fecha de vencimiento de pago (formato dd-mm-yyyy) */
  nextDueDate?: string;
  /** Gastos del período actual (no facturados) */
  periodExpenses?: number;
  /** Datos del último estado de cuenta facturado */
  lastStatement?: {
    /** Fecha de facturación dd-mm-yyyy */
    billingDate: string;
    /** Monto total facturado */
    billedAmount: number;
    /** Fecha de vencimiento dd-mm-yyyy */
    dueDate: string;
    /** Pago mínimo */
    minimumPayment?: number;
  };
  /** Movimientos de la tarjeta */
  movements?: BankMovement[];
}

/** Resultado del scraping */
export interface ScrapeResult {
  /** Si el scraping fue exitoso */
  success: boolean;
  /** Nombre del banco */
  bank: string;
  /** Cuentas bancarias con sus movimientos */
  accounts?: AccountBalance[];
  /** Saldos de tarjetas de crédito */
  creditCards?: CreditCardBalance[];
  /** @deprecated Use accounts[].movements instead. Kept for compatibility during migration. */
  movements?: BankMovement[];
  /** @deprecated Use accounts[].balance instead. Kept for compatibility during migration. */
  balance?: number;
  /** Cuentas bancarias listadas (sin movimientos) — para --cuentas */
  cuentas?: BankAccountInfo[];
  /** Agenda TEF cruda (listar-beneficiarios / validar-cuenta) */
  beneficiarios?: AgendaBeneficiario[];
  /** Si la cuenta está en la agenda (validar-cuenta) */
  cuentaValida?: boolean;
  /** Beneficiario encontrado (validar-cuenta) */
  beneficiario?: AgendaBeneficiario | null;
  /** Resultado de transferencia express */
  transferencia?: TransferenciaResult;
  /** Mensaje de error si success = false */
  error?: string;
  /** Screenshot en base64 (para debugging) */
  screenshot?: string;
  /** Log de debug con pasos del scraper */
  debug?: string;
}

/** Información de una cuenta bancaria (para listado de cuentas) */
export interface BankAccountInfo {
  /** Nombre de la empresa titular (solo empresas) */
  empresa?: string;
  /** RUT de la empresa (solo empresas) */
  rutEmpresa?: string;
  /** Número de cuenta */
  numero: string;
  /** Número enmascarado (ej: ****1234) */
  mascara?: string;
  /** Alias de la cuenta */
  alias?: string;
  /** Código de producto (ej: JUV, CCI) */
  codigoProducto?: string;
  /** Clase de cuenta (ej: CVIEMP, CCIEMP) */
  claseCuenta?: string;
  /** Moneda (CLP, USD, UF) */
  moneda?: string;
  /** Saldo actual (si se pudo obtener) */
  saldo?: number;
}

/** Credenciales de autenticación */
export interface BankCredentials {
  /** RUT del titular (con o sin formato, ej: "12345678-9" o "123456789") */
  rut: string;
  /** Clave de internet del banco */
  password: string;
}

/** Alcance de la consulta: personal o empresa */
export interface Scope {
  /** Tipo de alcance */
  type: "personal" | "business";
  /** RUT de la empresa (solo para business) */
  companyRut?: string;
}

/** Datos para agregar un beneficiario/cuenta en el banco */
export interface BeneficiarioData {
  /** Nombre exacto del banco en el dropdown (ej: "BANCO DEL ESTADO DE CHILE") */
  banco: string;
  /** Índice del banco en el dropdown (0-based, opcional) */
  bancoIndex?: number;
  /** Número de cuenta (máximo 20 caracteres) */
  numeroCuenta: string;
  /** Tipo de cuenta: 'Cuenta Corriente' | 'Cuenta Vista' | otro */
  tipoCuenta: string;
  /** RUT del beneficiario (con o sin formato, ej: "12345678-9") */
  rutBeneficiario: string;
  /** Nombre del beneficiario */
  nombreBeneficiario: string;
  /** Email del beneficiario (opcional) */
  email?: string;
}

/** Acción a ejecutar en el banco */
export type BankAction =
  | "scrape"
  | "listar-cuentas"
  | "listar-beneficiarios"
  | "agregar-beneficiario"
  | "validar-cuenta"
  | "transferencia-express";

/** Datos para validar si una cuenta está en la agenda TEF */
export interface ValidarCuentaData {
  rutBeneficiario: string;
  numeroCuenta: string;
}

/** Datos para transferencia express (Banco de Chile empresas) */
export interface TransferenciaExpressData {
  monto: number;
  rutBeneficiario: string;
  numeroCuenta: string;
  bankName?: string;
  /** Timeout de espera Mi Pass en ms (default 5 min) */
  timeoutMs?: number;
}

/** Beneficiario crudo de la agenda TEF */
export interface AgendaBeneficiario {
  rutBeneficiario?: string;
  numeroCuenta?: string;
  nombreRazonSocial?: string;
  alias?: string;
  tipoCuenta?: string;
  nombreBanco?: string;
  [key: string]: unknown;
}

/** Comprobante de transferencia express */
export interface TransferenciaComprobante {
  n_operacion?: string | null;
  monto?: string | null;
  nombre_destino?: string | null;
  rut_destino?: string | null;
  banco_destino?: string | null;
  cuenta_destino?: string | null;
  cuenta_origen?: string | null;
}

/** Resultado de transferencia express */
export interface TransferenciaResult {
  success: boolean;
  estado?: string;
  idOperacion?: string | null;
  comprobante?: TransferenciaComprobante;
  confirmacion?: string;
  error?: string;
}

/** Opciones para el scraper */
export interface ScraperOptions extends BankCredentials {
  /** Ruta al ejecutable de Chrome/Chromium. Si no se provee, busca automáticamente. */
  chromePath?: string;
  /** Si es true, guarda screenshots en ./screenshots/ para debugging */
  saveScreenshots?: boolean;
  /** Si es true, usa headless: false (para debugging visual) */
  headful?: boolean;
  /** Filtro Titular/Adicional para TC (ej: "T" = titular, "A" = adicional, "B" = todos). Default: "B" */
  owner?: "T" | "A" | "B";
  /** Alcance: personal (default) o business con RUT de empresa opcional */
  scope?: Scope;
  /** Acción a ejecutar (default: "scrape") */
  action?: BankAction;
  /** Datos del beneficiario para action="agregar-beneficiario" */
  beneficiario?: BeneficiarioData;
  /** Datos para action="validar-cuenta" */
  validar?: ValidarCuentaData;
  /** Datos para action="transferencia-express" */
  transferencia?: TransferenciaExpressData;
  /**
   * Página Puppeteer ya autenticada. Si se provee, no se abre ni cierra Chrome
   * y se omite login/logout (para sidecars con sesión persistente).
   */
  page?: unknown;
  /** Si es true, no cierra sesión al terminar (implícito si se pasa `page`). */
  skipLogout?: boolean;
  /** @deprecated Use scope.type="business" en su lugar. */
  empresa?: boolean;
  /** @deprecated Use scope.companyRut en su lugar. */
  bankQuery?: string;
  /** Callback de progreso para mostrar estado al usuario */
  onProgress?: (step: string) => void;
  /** Callback invocado en cada línea de debug en tiempo real */
  onDebug?: (line: string) => void;
}

/** Interfaz que debe implementar cada banco */
export interface BankScraper {
  /** Identificador único del banco (ej: "falabella", "santander") */
  id: string;
  /** Nombre completo del banco */
  name: string;
  /** URL del portal web del banco */
  url: string;
  /** Ejecutar el scraping */
  scrape(options: ScraperOptions): Promise<ScrapeResult>;
}

export { MOVEMENT_SOURCE as default };
