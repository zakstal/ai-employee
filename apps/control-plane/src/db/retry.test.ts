import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { isTransientDbError, retryTransient } from "./retry.js";
import { Ledger } from "./ledger.js";
import { attachPoolErrorHandler, poolOptions } from "./pool.js";

const reset = () => Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
const input = { employeeId: "dev", roleId: "r", prompt: "p", source: { channel: "http" as const } };

describe("isTransientDbError", () => {
  it.each([
    [reset()],
    [new Error("Connection terminated unexpectedly")],
    [new Error("Connection terminated due to connection timeout")],
    [new Error("failed to connect to `instance`: dial error (timeout)")],
    [Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" })],
    [Object.assign(new Error("x"), { code: "08006" })],
  ])("treats %s as transient", (e) => expect(isTransientDbError(e)).toBe(true));

  it.each([[Object.assign(new Error("duplicate key"), { code: "23505" })], [new Error("syntax error at or near")], ["str"], [undefined]])("does not retry %s", (e) =>
    expect(isTransientDbError(e)).toBe(false),
  );
});

describe("retryTransient", () => {
  it("retries once on a transient error and returns the second result", async () => {
    const fn = vi.fn().mockRejectedValueOnce(reset()).mockResolvedValueOnce("ok");
    expect(await retryTransient(fn, { delayMs: 0 })).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
  it("gives up after the retry budget", async () => {
    const fn = vi.fn().mockRejectedValue(reset());
    await expect(retryTransient(fn, { delayMs: 0 })).rejects.toThrow("ECONNRESET");
    expect(fn).toHaveBeenCalledTimes(2);
  });
  it("never retries a non-transient error", async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error("duplicate key"), { code: "23505" }));
    await expect(retryTransient(fn, { delayMs: 0 })).rejects.toThrow("duplicate key");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("Ledger.createTask on a fake pool whose first connection is dead", () => {
  it("retries the idempotent insert and reports it created", async () => {
    const query = vi.fn().mockRejectedValueOnce(new Error("Connection terminated unexpectedly")).mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const created = await new Ledger({ query } as unknown as pg.Pool).createTask("http:dev:k", input);
    expect(created).toBe(true);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]![1]).toEqual(query.mock.calls[0]![1]); // same task id both times: the dedup key
  });
  it("still reports a dedup hit as false", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    expect(await new Ledger({ query } as unknown as pg.Pool).createTask("http:dev:k", input)).toBe(false);
  });
  it("surfaces a second failure and does not retry a constraint error", async () => {
    const dead = vi.fn().mockRejectedValue(reset());
    await expect(new Ledger({ query: dead } as unknown as pg.Pool).createTask("a", input)).rejects.toThrow("ECONNRESET");
    expect(dead).toHaveBeenCalledTimes(2);
    const fk = vi.fn().mockRejectedValue(Object.assign(new Error("violates foreign key"), { code: "23503" }));
    await expect(new Ledger({ query: fk } as unknown as pg.Pool).createTask("a", input)).rejects.toThrow("foreign key");
    expect(fk).toHaveBeenCalledTimes(1);
  });
  it("upsertConversation retries too", async () => {
    const query = vi.fn().mockRejectedValueOnce(reset()).mockResolvedValueOnce({ rows: [{ id: "c1" }] });
    expect(await new Ledger({ query } as unknown as pg.Pool).upsertConversation("dev", "telegram", "1")).toBe("c1");
  });
});

describe("pool", () => {
  it("probes idle sockets and expires idle clients", () => {
    expect(poolOptions("postgres://x")).toMatchObject({ keepAlive: true, idleTimeoutMillis: 30_000 });
  });
  it("an idle-client error is handled (logged) instead of crashing the process", async () => {
    const { EventEmitter } = await import("node:events");
    const p = new EventEmitter() as unknown as pg.Pool;
    attachPoolErrorHandler(p);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => p.emit("error", reset())).not.toThrow();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
