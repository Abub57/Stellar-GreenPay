"use strict";

jest.mock("./stellar", () => ({
  server: { orderbook: jest.fn() },
}));

const cache = require("./cache");
const { server: horizonServer } = require("./stellar");
const { getUsdcToXlmRate, FALLBACK_XLM_PER_USDC } = require("./priceOracle");

const CACHE_KEY = "xlm_usdc_mid_price";

function mockOrderbookCall(call) {
  horizonServer.orderbook.mockReturnValue({
    limit: jest.fn(() => ({ call })),
  });
}

function orderbook(askNumerator, askDenominator, bidNumerator, bidDenominator) {
  return {
    asks: [{ price_r: { n: askNumerator, d: askDenominator } }],
    bids: [{ price_r: { n: bidNumerator, d: bidDenominator } }],
  };
}

beforeEach(() => {
  cache.del(CACHE_KEY);
  horizonServer.orderbook.mockReset();
  jest.useRealTimers();
});

afterEach(() => {
  cache.del(CACHE_KEY);
  jest.useRealTimers();
});

describe("services/priceOracle", () => {
  test("fetches the XLM/USDC orderbook and parses the rational mid-price", async () => {
    const call = jest.fn().mockResolvedValue(orderbook(17, 2, 16, 2));
    mockOrderbookCall(call);

    await expect(getUsdcToXlmRate()).resolves.toBe(8.25);
    expect(horizonServer.orderbook).toHaveBeenCalledWith(
      {
        asset_type: "credit_alphanum4",
        asset_code: "USDC",
        asset_issuer: expect.any(String),
      },
      { asset_type: "native" },
    );
    expect(call).toHaveBeenCalledTimes(1);
  });

  test("reuses a fresh cached quote without another Horizon request", async () => {
    const call = jest.fn().mockResolvedValue(orderbook(9, 1, 7, 1));
    mockOrderbookCall(call);

    await expect(getUsdcToXlmRate()).resolves.toBe(8);
    await expect(getUsdcToXlmRate()).resolves.toBe(8);
    expect(call).toHaveBeenCalledTimes(1);
  });

  test("falls back after a provider HTTP error and retries instead of caching the failure", async () => {
    const call = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("Horizon unavailable"), { response: { status: 503 } }))
      .mockResolvedValueOnce(orderbook(10, 1, 8, 1));
    mockOrderbookCall(call);

    await expect(getUsdcToXlmRate()).resolves.toBe(FALLBACK_XLM_PER_USDC);
    await expect(getUsdcToXlmRate()).resolves.toBe(9);
    expect(call).toHaveBeenCalledTimes(2);
  });

  test("treats an expired quote as stale and fetches a fresh mid-price", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-10-15T12:00:00Z"));
    const call = jest
      .fn()
      .mockResolvedValueOnce(orderbook(10, 1, 8, 1))
      .mockResolvedValueOnce(orderbook(12, 1, 10, 1));
    mockOrderbookCall(call);

    await expect(getUsdcToXlmRate()).resolves.toBe(9);
    jest.advanceTimersByTime(30_001);
    await expect(getUsdcToXlmRate()).resolves.toBe(11);
    expect(call).toHaveBeenCalledTimes(2);
  });

  test("uses and caches the fallback when either side of the book is empty", async () => {
    const call = jest.fn().mockResolvedValue({ asks: [], bids: [{ price_r: { n: 8, d: 1 } }] });
    mockOrderbookCall(call);

    await expect(getUsdcToXlmRate()).resolves.toBe(FALLBACK_XLM_PER_USDC);
    await expect(getUsdcToXlmRate()).resolves.toBe(FALLBACK_XLM_PER_USDC);
    expect(call).toHaveBeenCalledTimes(1);
  });
});
