import type { EtimsDocumentSnapshot, EtimsRequestPayload, EtimsResponsePayload, EtimsResult } from "@/lib/tax";

import { getEtimsSpec, type EtimsSpec } from "./spec";

/** Virtual Sales Control Unit endpoint family. */
export const VSCU_ENDPOINT = "invoice/vscu";

export const vscuSpec: EtimsSpec = {
  ...getEtimsSpec("vscu-1.0"),
  buildPayload(document: EtimsDocumentSnapshot): EtimsRequestPayload {
    return getEtimsSpec("vscu-1.0").buildPayload(document);
  },
  parseResponse(payload: EtimsResponsePayload, httpStatus: number): EtimsResult {
    return getEtimsSpec("vscu-1.0").parseResponse(payload, httpStatus);
  },
};
