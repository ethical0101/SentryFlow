import { describe, expect, it } from "vitest";
import { conditionText, countdown, describeAction, shortHash, timeAgo } from "./format";

describe("format helpers", () => {
  it("describes tool calls in plain language", () => {
    expect(describeAction("set_light", { lightId: "all", on: false })).toBe("Turn all lights off");
    expect(describeAction("set_thermostat", { mode: "eco" })).toBe("Thermostat → eco");
    expect(describeAction("set_security_mode", { mode: "disarmed" })).toBe("Disarm security system");
    expect(describeAction("purchase_item", { sku: "air_filter", quantity: 2 })).toBe("Order 2 × air filter");
    expect(describeAction("mystery_tool", {})).toBe("mystery tool");
  });

  it("formats hashes, durations and conditions", () => {
    expect(shortHash("abcdef0123456789", 6)).toBe("abcdef…");
    expect(shortHash(undefined)).toBe("—");
    const now = Date.parse("2026-10-10T12:00:00Z");
    expect(timeAgo("2026-10-10T11:58:00Z", now)).toBe("2m ago");
    expect(countdown("2026-10-10T12:04:05Z", now)).toBe("4:05");
    expect(countdown("2026-10-10T11:00:00Z", now)).toBe("0:00");
    expect(conditionText({ fact: "args.targetC", op: "lt", value: 16 })).toBe("args.targetC < 16");
  });
});
