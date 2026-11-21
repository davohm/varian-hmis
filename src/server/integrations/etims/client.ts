import {
  type EtimsClientConfig,
  type EtimsDocumentSnapshot,
  type EtimsHttpResponse,
  type EtimsRequestPayload,
  type EtimsResult,
  type EtimsTransport,
} from "@/lib/tax";

import { OSCU_ENDPOINT } from "./oscu";
import { isSandboxStubUrl, sandboxEtimsTransport } from "./sandbox";
import { getEtimsSpec } from "./spec";
import { VSCU_ENDPOINT } from "./vscu";

/** Builds the exact payload that will be stored in the outbox and sent to KRA. */
export function buildEtimsRequestPayload(
  document: EtimsDocumentSnapshot,
  config: EtimsClientConfig,
): EtimsRequestPayload {
  const payload = getEtimsSpec(config.specVersion).buildPayload(document);
  payload.environment = config.environment;
  return payload;
}

export interface EtimsSendResult {
  requestPayload: EtimsRequestPayload;
  response: EtimsHttpResponse;
  result: EtimsResult;
}

export interface EtimsClient {
  send(document: EtimsDocumentSnapshot): Promise<EtimsSendResult>;
}

function assertEnvironmentTarget(config: EtimsClientConfig, env: NodeJS.ProcessEnv): void {
  const baseUrl = config.baseUrl.trim();
  const productionUrl = env.ETIMS_PRODUCTION_BASE_URL?.trim().toLowerCase();

  if (config.environment === "production") {
    if (env.ETIMS_ALLOW_PRODUCTION !== "true") {
      throw new Error("Production eTIMS transmissions are disabled for this installation");
    }
    if (isSandboxStubUrl(baseUrl) || /sandbox/i.test(baseUrl)) {
      throw new Error("A sandbox target cannot be used for production eTIMS transmission");
    }
    if (productionUrl && baseUrl.toLowerCase() === productionUrl) return;
    return;
  }

  if (/production|\/prod(?:uction)?(?:\/|$)/i.test(baseUrl)) {
    throw new Error("A sandbox run cannot target a production eTIMS endpoint");
  }
  if (productionUrl && baseUrl.toLowerCase() === productionUrl) {
    throw new Error("A sandbox run cannot target the configured production eTIMS endpoint");
  }
}

function resolveCredential(config: EtimsClientConfig, env: NodeJS.ProcessEnv): string | null {
  if (!config.credentialRef) return null;
  const value = env[config.credentialRef] ?? null;
  if (!value && !isSandboxStubUrl(config.baseUrl)) {
    throw new Error(`The eTIMS credential reference ${config.credentialRef} is not configured`);
  }
  return value;
}

function httpTransport(fetchImpl: typeof fetch, credential: string | null): EtimsTransport {
  return async (payload, config) => {
    const endpoint = config.mode === "vscu" ? VSCU_ENDPOINT : OSCU_ENDPOINT;
    const url = `${config.baseUrl.replace(/\/+$/, "")}/${endpoint}`;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (credential) headers.authorization = `Bearer ${credential}`;

    const response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { resultMsg: "KRA returned a non-JSON response" };
      }
    }
    return {
      status: response.status,
      payload: (parsed ?? {}) as EtimsHttpResponse["payload"],
    };
  };
}

/**
 * Builds the KRA client from integration settings plus server-held credentials.
 * `transport` is injectable so tests can stub HTTP without touching the queue.
 */
export function createEtimsClient(
  config: EtimsClientConfig,
  options: { transport?: EtimsTransport; fetch?: typeof fetch; env?: NodeJS.ProcessEnv } = {},
): EtimsClient {
  const env = options.env ?? process.env;
  assertEnvironmentTarget(config, env);
  const credential = resolveCredential(config, env);
  const transport =
    options.transport ??
    (isSandboxStubUrl(config.baseUrl)
      ? sandboxEtimsTransport
      : httpTransport(options.fetch ?? fetch, credential));
  const spec = getEtimsSpec(config.specVersion);

  return {
    async send(document) {
      const requestPayload = buildEtimsRequestPayload(document, config);
      const response = await transport(requestPayload, config);
      return {
        requestPayload,
        response,
        result: spec.parseResponse(response.payload, response.status),
      };
    },
  };
}
