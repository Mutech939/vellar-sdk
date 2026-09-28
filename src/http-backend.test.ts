import { describe, expect, it, vi } from "vitest";
import {
  createHttpWalletBackend,
  WalletApiError,
  type HttpErrorLogEntry,
} from "./http-backend";

const API_URL = "https://api.vellar.test";

describe("createHttpWalletBackend structured error logging hook (#247)", () => {
  it("invokes onErrorLog with method, url, status, and duration on HTTP error", async () => {
    const errorLogs: HttpErrorLogEntry[] = [];
    const mockFetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );

    const backend = createHttpWalletBackend(API_URL, {
      fetchImpl: mockFetch as unknown as typeof fetch,
      onErrorLog: (entry) => errorLogs.push(entry),
    });

    await expect(
      backend.submitTransaction({ signedXdr: "xdr-data", network: "testnet" }),
    ).rejects.toThrow(WalletApiError);

    expect(errorLogs).toHaveLength(1);
    const log = errorLogs[0]!;
    expect(log.method).toBe("POST");
    expect(log.url).toBe("https://api.vellar.test/wallet/submit");
    expect(log.status).toBe(401);
    expect(typeof log.duration).toBe("number");
    expect(log.duration).toBeGreaterThanOrEqual(0);
  });

  it("invokes onErrorLog with status 0 on network/fetch failure", async () => {
    const errorLogs: HttpErrorLogEntry[] = [];
    const mockFetch = vi.fn(async () => {
      throw new Error("Network connection dropped");
    });

    const backend = createHttpWalletBackend(
      API_URL,
      mockFetch as unknown as typeof fetch,
      { onErrorLog: (entry) => errorLogs.push(entry) },
    );

    await expect(
      backend.lookupContractId({ keyId: "key-1", network: "testnet" }),
    ).rejects.toThrow("Network connection dropped");

    expect(errorLogs).toHaveLength(1);
    const log = errorLogs[0]!;
    expect(log.method).toBe("POST");
    expect(log.url).toBe("https://api.vellar.test/wallet/connect");
    expect(log.status).toBe(0);
    expect(typeof log.duration).toBe("number");
    expect(log.duration).toBeGreaterThanOrEqual(0);
  });

  it("does not invoke onErrorLog when requests succeed", async () => {
    const errorLogs: HttpErrorLogEntry[] = [];
    const mockFetch = vi.fn(async () =>
      new Response(JSON.stringify({ sessionId: "sess-abc" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const backend = createHttpWalletBackend(API_URL, {
      fetchImpl: mockFetch as unknown as typeof fetch,
      onErrorLog: (entry) => errorLogs.push(entry),
    });

    const result = await backend.submitWalletCreation({
      keyId: "key-1",
      contractId: "C123",
      network: "testnet",
      signedTx: "tx-xdr",
    });

    expect(result.sessionId).toBe("sess-abc");
    expect(errorLogs).toHaveLength(0);
  });
});
