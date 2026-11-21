import {
  DEFAULT_ETIMS_SPEC_VERSION,
  type EtimsDocumentSnapshot,
  type EtimsRequestPayload,
  type EtimsResponsePayload,
  type EtimsResult,
} from "@/lib/tax";

export interface EtimsSpec {
  version: string;
  buildPayload(document: EtimsDocumentSnapshot): EtimsRequestPayload;
  parseResponse(payload: EtimsResponsePayload, httpStatus: number): EtimsResult;
}

function basePayload(
  document: EtimsDocumentSnapshot,
  specVersion: string,
  channel: "OSCU" | "VSCU",
): EtimsRequestPayload {
  return {
    specVersion,
    channel,
    environment: "sandbox",
    requestId: document.idempotencyKey,
    documentType: document.documentType,
    invoice: {
      number: document.invoiceNo,
      date: document.invoiceDate,
      creditNoteOf: document.originalInvoiceNo ?? document.creditNoteOf,
      currency: document.currency,
      totalAmount: document.totalAmount,
      taxAmount: document.taxAmount,
    },
    seller: {
      name: document.facilityName,
      pin: document.kraPin,
      branchCode: document.facilityCode,
    },
    buyer: {
      name: document.buyerName,
      pin: document.buyerPin,
      type: document.buyerType,
    },
    lines: document.lines,
  };
}

function parseResponse(payload: EtimsResponsePayload, httpStatus: number): EtimsResult {
  const responseCode = String(payload.resultCode ?? payload.responseCode ?? "");
  const responseMessage =
    String(payload.resultMsg ?? payload.responseMessage ?? "KRA returned no message") || "KRA returned no message";

  if (httpStatus >= 500) {
    return { outcome: "failed", responseCode: responseCode || `HTTP-${httpStatus}`, responseMessage };
  }
  if (httpStatus >= 400 || (responseCode && !/^(00|000)$/.test(responseCode))) {
    return { outcome: "rejected", responseCode: responseCode || `HTTP-${httpStatus}`, responseMessage };
  }
  if (!payload.controlNo || !payload.signature) {
    return {
      outcome: "rejected",
      responseCode: responseCode || "INVALID-ACK",
      responseMessage: "KRA accepted the request but returned no control number or signature",
    };
  }
  return {
    outcome: "acknowledged",
    controlNo: String(payload.controlNo),
    signature: String(payload.signature),
    qrUrl: String(payload.qrUrl ?? ""),
    cuNo: payload.cuNo ? String(payload.cuNo) : null,
    responseCode: responseCode || "00",
    responseMessage,
  };
}

const specs = new Map<string, EtimsSpec>([
  [
    "oscu-1.0",
    {
      version: "oscu-1.0",
      buildPayload: (document) => basePayload(document, "oscu-1.0", "OSCU"),
      parseResponse,
    },
  ],
  [
    "vscu-1.0",
    {
      version: "vscu-1.0",
      buildPayload: (document) => basePayload(document, "vscu-1.0", "VSCU"),
      parseResponse,
    },
  ],
]);

/** Spec mappings are configuration rows; new versions add a module, never a queue edit. */
export function getEtimsSpec(version: string | null | undefined): EtimsSpec {
  return specs.get(version ?? DEFAULT_ETIMS_SPEC_VERSION) ?? specs.get(DEFAULT_ETIMS_SPEC_VERSION)!;
}
