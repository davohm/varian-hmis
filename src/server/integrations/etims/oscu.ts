import type { EtimsDocumentSnapshot, EtimsRequestPayload, EtimsResponsePayload, EtimsResult } from "@/lib/tax";

import { getEtimsSpec, type EtimsSpec } from "./spec";

/** Online Sales Control Unit endpoint family. */
export const OSCU_ENDPOINT = "invoice/oscu";

export const oscuSpec: EtimsSpec = {
  ...getEtimsSpec("oscu-1.0"),
  buildPayload(document: EtimsDocumentSnapshot): EtimsRequestPayload {
    return getEtimsSpec("oscu-1.0").buildPayload(document);
  },
  parseResponse(payload: EtimsResponsePayload, httpStatus: number): EtimsResult {
    return getEtimsSpec("oscu-1.0").parseResponse(payload, httpStatus);
  },
};
