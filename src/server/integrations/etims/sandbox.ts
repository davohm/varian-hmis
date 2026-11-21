import { createHash } from "node:crypto";

import {
  ETIMS_SANDBOX_STUB_URL,
  type EtimsHttpResponse,
  type EtimsRequestPayload,
  type EtimsTransport,
} from "@/lib/tax";

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 10).toUpperCase();
}

function qrDataUrl(controlNo: string, signature: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160"><rect width="160" height="160" fill="white"/><g fill="black">${Array.from(
    { length: 121 },
    (_, index) => {
      const x = index % 11;
      const y = Math.floor(index / 11);
      const on = (shortHash(`${controlNo}:${signature}:${index}`).charCodeAt(0) & 1) === 1;
      return on ? `<rect x="${8 + x * 13}" y="${8 + y * 13}" width="11" height="11"/>` : "";
    },
  ).join("")}</g></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

/**
 * Deterministic local KRA simulator. The control number is derived from the
 * request id, so a retried request after a timeout never allocates a second
 * control number. It is only reachable from the sandbox stub base URL.
 */
export const sandboxEtimsTransport: EtimsTransport = async (
  payload: EtimsRequestPayload,
): Promise<EtimsHttpResponse> => {
  const controlNo = `KRA-${shortHash(payload.requestId)}`;
  const signature = `SIG-${shortHash(`${payload.requestId}:signature`)}`;
  return {
    status: 200,
    payload: {
      resultCode: "00",
      resultMsg: "Accepted by KRA sandbox",
      controlNo,
      signature,
      qrUrl: qrDataUrl(controlNo, signature),
      cuNo: `CU-${shortHash(`${payload.requestId}:cu`)}`,
    },
  };
};

export function isSandboxStubUrl(baseUrl: string): boolean {
  return baseUrl.trim().toLowerCase().startsWith(ETIMS_SANDBOX_STUB_URL);
}
