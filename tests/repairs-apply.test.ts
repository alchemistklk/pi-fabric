import { describe, expect, it } from "vitest";
import {
  applyActionAliasRepairs,
  applyCatalogArgRepairs,
} from "../src/repairs/apply.js";

const sessionSchema = {
  type: "object",
  properties: { session: { type: "string" }, entryId: { type: "string" } },
  additionalProperties: false,
};

describe("applyCatalogArgRepairs", () => {
  const repairs = [
    { kind: "keyAlias" as const, ref: "memory.expand", from: "sessionId", to: "session" },
  ];

  it("is idempotent and canonical-wins against the live schema", () => {
    const once = applyCatalogArgRepairs(
      "memory.expand",
      { sessionId: "s1", extra: true },
      repairs,
      sessionSchema,
    );
    expect(once).toEqual({ args: { session: "s1", extra: true }, changed: true });
    expect(applyCatalogArgRepairs("memory.expand", once.args, repairs, sessionSchema)).toEqual({
      args: once.args,
      changed: false,
    });
    expect(
      applyCatalogArgRepairs(
        "memory.expand",
        { session: "canonical", sessionId: "alias" },
        repairs,
        sessionSchema,
      ).args.session,
    ).toBe("canonical");
  });

  it("re-proves a stored map against the complete live object schema", () => {
    expect(
      applyCatalogArgRepairs(
        "memory.expand",
        { sessionId: "s1" },
        repairs,
        {
          ...sessionSchema,
          properties: { sessionId: { type: "string" }, entryId: { type: "string" } },
        },
      ),
    ).toEqual({ args: { sessionId: "s1" }, changed: false });
    expect(
      applyCatalogArgRepairs("memory.expand", { sessionId: "s1" }, repairs, {
        ...sessionSchema,
        properties: { entryId: { type: "string" } },
      }),
    ).toEqual({ args: { sessionId: "s1" }, changed: false });
    expect(
      applyCatalogArgRepairs("memory.expand", { sessionId: "s1" }, repairs, {
        ...sessionSchema,
        properties: { session: { type: "string" }, path: { type: "string" } },
      }),
    ).toEqual({ args: { sessionId: "s1" }, changed: false });
    expect(
      applyCatalogArgRepairs("memory.expand", { sessionId: "s1" }, repairs, {
        ...sessionSchema,
        additionalProperties: true,
      }),
    ).toEqual({ args: { sessionId: "s1" }, changed: false });
  });

  it("refuses ambiguous many-to-one aliases when canonical input is absent", () => {
    const aliases = [
      ...repairs,
      { kind: "keyAlias" as const, ref: "memory.expand", from: "path", to: "session" },
    ];
    expect(
      applyCatalogArgRepairs(
        "memory.expand",
        { sessionId: "s1", path: "s2" },
        aliases,
        sessionSchema,
      ),
    ).toEqual({ args: { sessionId: "s1", path: "s2" }, changed: false });
  });
});

describe("applyActionAliasRepairs", () => {
  const repairs = [
    { kind: "actionAlias" as const, provider: "memory", from: "search", to: "recall" },
  ];

  it("rewrites a unique verb that is still undeclared", () => {
    expect(applyActionAliasRepairs("memory", "search", repairs, ["recall", "expand"])).toBe(
      "recall",
    );
  });

  it("does not rewrite when the live mapping is invalid or ambiguous", () => {
    expect(applyActionAliasRepairs("memory", "search", repairs, ["search", "recall"])).toBeUndefined();
    expect(applyActionAliasRepairs("memory", "search", repairs, ["expand"])).toBeUndefined();
    expect(
      applyActionAliasRepairs("memory", "search", repairs, ["recall", "find"]),
    ).toBeUndefined();
  });
});
