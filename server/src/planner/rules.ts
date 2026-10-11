import type { Proposal } from "./normalize.js";
import { restrictionStart, sentences } from "./constraints.js";
import { canonicalJson } from "../domain/canonical.js";

/**
 * Deterministic, keyword-based planner. Used when Ollama is unavailable, fails, or is disabled.
 * It is intentionally simple and transparent; its output goes through exactly the same validation
 * and policy evaluation as model output.
 */

type Draft = Omit<Proposal, "ref" | "dependsOn"> & { dependsOnKinds?: string[] };

const ROOMS: [RegExp, string][] = [
  [/\b(living ?room|lounge)\b/i, "living_room"],
  [/\bkitchen\b/i, "kitchen"],
  [/\bbed ?room\b/i, "bedroom"],
  [/\b(porch|outside|outdoor)\b/i, "porch"],
];

const PRODUCTS: [RegExp, string][] = [
  [/\bcoffee\b/i, "coffee_beans"],
  [/\bpaper towels?\b/i, "paper_towels"],
  [/\b(light ?)?bulbs?\b/i, "led_bulbs_4pk"],
  [/\b(air )?filters?\b/i, "air_filter"],
  [/\bsmart plugs?\b|\bplugs?\b/i, "smart_plug"],
  [/\b(robot )?vacuum\b/i, "robot_vacuum"],
];

const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };

function doorsIn(text: string): string[] {
  const doors: string[] = [];
  if (/\bfront\b/i.test(text)) doors.push("front_door");
  if (/\b(back|rear)\b/i.test(text)) doors.push("back_door");
  if (doors.length === 0) {
    if (/\b(all|every|both)\b|\bdoors\b/i.test(text)) return ["front_door", "back_door"];
    return ["front_door"];
  }
  return doors;
}

function toCelsius(value: number, unit: string | undefined): number {
  const isF = unit ? /^f/i.test(unit) : value > 45;
  const c = isF ? ((value - 32) * 5) / 9 : value;
  return Math.round(c * 2) / 2;
}

function lightIntent(clause: string, ctx: { lastLightOn?: boolean }): Draft[] {
  const mentionsLights = /\b(lights?|lamps?|lighting)\b/i.test(clause);
  const rooms = ROOMS.filter(([re]) => re.test(clause)).map(([, id]) => id);
  // "…and the bedroom" continues the previous light command.
  if (!mentionsLights && !(rooms.length > 0 && ctx.lastLightOn !== undefined && !/\b(thermostat|door|camera)\b/i.test(clause)))
    return [];
  const dim = /\bdim\w*\b.*?(\d{1,3})\s*%?/i.exec(clause);
  let on: boolean | undefined;
  if (/\b(off|out)\b/i.test(clause)) on = false;
  else if (/\bon\b/i.test(clause) || dim) on = true;
  on ??= ctx.lastLightOn;
  if (on === undefined) return [];
  ctx.lastLightOn = on;
  const targets = rooms.length > 0 && !/\ball\b/i.test(clause) ? rooms : ["all"];
  return targets.map((lightId) => ({
    tool: "set_light",
    args: { lightId, on, ...(dim && on ? { brightness: Math.min(100, Number(dim[1])) } : {}) },
    explanation: `Turn ${lightId === "all" ? "all lights" : lightId.replace("_", " ") + " light"} ${on ? "on" : "off"}${dim ? ` at ${dim[1]}%` : ""}.`,
  }));
}

function thermostatIntent(clause: string): Draft[] {
  if (!/\b(thermostat|heat\w*|a\/?c|air ?con\w*|temperature|cool\w*|eco)\b/i.test(clause)) return [];
  let mode = "auto";
  if (/\beco\b|energy.?sav|away mode/i.test(clause)) mode = "eco";
  else if (/\b(turn|switch|shut) off\b.*\b(heat\w*|thermostat|a\/?c|air ?con\w*)\b|\b(heat\w*|thermostat|a\/?c)\b.*\boff\b/i.test(clause)) mode = "off";
  else if (/\bheat\w*|warm\w*/i.test(clause)) mode = "heat";
  else if (/\bcool\w*|\ba\/?c\b|air ?con/i.test(clause)) mode = "cool";
  const num = /(-?\d+(?:\.\d+)?)\s*(?:°|º|degrees?|deg)?\s*(c|f|celsius|fahrenheit)?\b/i.exec(clause);
  const args: Record<string, unknown> = { mode };
  if (num && mode !== "off") args.targetC = toCelsius(Number(num[1]), num[2]);
  return [
    {
      tool: "set_thermostat",
      args,
      explanation: `Set thermostat to ${mode}${args.targetC !== undefined ? ` at ${String(args.targetC)} °C` : ""}.`,
    },
  ];
}

function doorIntent(clause: string): Draft[] {
  if (/\bunlock\b|\bopen (the |a )?(front |back )?door/i.test(clause)) {
    return doorsIn(clause).map((doorId) => ({ tool: "unlock_door", args: { doorId }, explanation: `Unlock the ${doorId.replace("_", " ")}.` }));
  }
  if (/\block\b/i.test(clause)) {
    return doorsIn(clause).map((doorId) => ({ tool: "lock_door", args: { doorId }, explanation: `Lock the ${doorId.replace("_", " ")}.` }));
  }
  return [];
}

function securityIntent(clause: string): Draft[] {
  if (/\bdisarm\w*|\b(disable|turn off|deactivate|switch off)\b[^,]*\b(security|alarm)\b/i.test(clause)) {
    return [{ tool: "set_security_mode", args: { mode: "disarmed" }, explanation: "Disarm the security system." }];
  }
  if (/\barm\b|\b(enable|turn on|activate|switch on)\b[^,]*\b(security|alarm)\b/i.test(clause)) {
    const mode = /\b(home|stay|night)\b/i.test(clause) ? "armed_home" : "armed_away";
    return [{ tool: "set_security_mode", args: { mode }, explanation: `Arm the security system (${mode.replace("_", " ")}).` }];
  }
  return [];
}

function cameraIntent(clause: string): Draft[] {
  if (!/\bcam(era)?s?\b/i.test(clause)) return [];
  const off = /\b(off|disable\w*|stop\w*|pause\w*)\b/i.test(clause);
  const on = /\b(on|enable\w*|start\w*|resume\w*)\b/i.test(clause);
  if (!off && !on) return [];
  const ids: string[] = [];
  if (/\b(backyard|back ?yard|back|garden)\b/i.test(clause)) ids.push("backyard_cam");
  if (/\b(front|door ?bell|porch)\b/i.test(clause)) ids.push("front_door_cam");
  const cams = ids.length ? ids : ["front_door_cam", "backyard_cam"];
  return cams.map((cameraId) => ({
    tool: "set_camera_recording",
    args: { cameraId, recording: !off },
    explanation: `${off ? "Stop" : "Start"} recording on ${cameraId.replace(/_/g, " ")}.`,
  }));
}

function routineIntent(clause: string): Draft[] {
  if (/\b(prepare|get|make) (the )?(house|home)( ready)?\b|\bleav(e|ing)\b|\bheading out\b|\bgoing (away|out)\b/i.test(clause))
    return [{ tool: "enable_routine", args: { routineId: "leaving_home" }, explanation: "Enable the Leaving Home routine.", dependsOnKinds: ["set_light", "set_thermostat", "lock_door"] }];
  if (/\bgood ?night\b|\bbed ?time\b/i.test(clause))
    return [{ tool: "enable_routine", args: { routineId: "good_night" }, explanation: "Enable the Good Night routine." }];
  if (/\bvacation\b|\bholiday\b/i.test(clause))
    return [{ tool: "enable_routine", args: { routineId: "vacation_mode" }, explanation: "Enable Vacation Mode." }];
  return [];
}

function purchaseIntent(clause: string): Draft[] {
  const m = /\b(buy|order|purchase|reorder|get me)\b\s+(.*)$/i.exec(clause);
  if (!m || /\bin order to\b/i.test(clause)) return [];
  const rest = m[2] ?? "";
  const product = PRODUCTS.find(([re]) => re.test(rest));
  const qtyMatch = /^(?:(\d+)|(a|an|one|two|three|four|five|six))\b/i.exec(rest.trim());
  const quantity = qtyMatch ? (qtyMatch[1] ? Number(qtyMatch[1]) : (NUMBER_WORDS[qtyMatch[2]!.toLowerCase()] ?? 1)) : 1;
  return [
    {
      tool: "purchase_item",
      // An unknown product is passed through as-is so validation rejects it visibly.
      args: { sku: product ? product[1] : rest.trim().slice(0, 40), quantity },
      explanation: `Order ${quantity} × ${product ? product[1].replace(/_/g, " ") : rest.trim().slice(0, 40)} (simulated).`,
    },
  ];
}

function statusIntent(clause: string): Draft[] {
  if (!/\b(status|check|is the|are the|what'?s|what is|show me|tell me)\b/i.test(clause)) return [];
  if (/\b(security|alarm|locked|lock|door|camera)\b/i.test(clause))
    return [{ tool: "get_security_status", args: {}, explanation: "Read the security status." }];
  if (/\b(state|devices?|temperature|thermostat|lights?|house|home)\b/i.test(clause))
    return [{ tool: "get_device_state", args: {}, explanation: "Read the current device state." }];
  return [];
}

export function planWithRules(request: string): Proposal[] {
  const drafts: Draft[] = [];
  const ctx: { lastLightOn?: boolean } = {};
  for (const sentence of sentences(request.slice(0, 2000))) {
    // Anything from a negation onwards is a restriction, not a command ("never unlock a door").
    const cut = restrictionStart(sentence);
    const actionable = cut >= 0 ? sentence.slice(0, cut) : sentence;
    const clauses = actionable.split(/,|;|\band then\b|\bthen\b|\band\b|\balso\b/i).map((c) => c.trim()).filter(Boolean);
    for (const clause of clauses) {
      const status = statusIntent(clause);
      if (status.length) {
        drafts.push(...status);
        continue;
      }
      const security = securityIntent(clause);
      const found = [
        ...purchaseIntent(clause),
        ...cameraIntent(clause),
        ...(security.length ? security : doorIntent(clause)),
        ...thermostatIntent(clause),
        ...lightIntent(clause, ctx),
        ...routineIntent(clause),
      ];
      drafts.push(...found);
    }
  }

  // De-duplicate identical tool+args (e.g. "I'm leaving… prepare the house").
  const seen = new Set<string>();
  const unique = drafts.filter((d) => {
    const key = canonicalJson({ t: d.tool, a: d.args });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Routines run after the device changes they summarise.
  const ordered = [...unique.filter((d) => d.tool !== "enable_routine"), ...unique.filter((d) => d.tool === "enable_routine")];
  return ordered.map((d, i) => {
    const ref = `p${i + 1}`;
    const deps = d.dependsOnKinds
      ? ordered.slice(0, i).flatMap((o, j) => (d.dependsOnKinds!.includes(o.tool) ? [`p${j + 1}`] : []))
      : [];
    return { ref, tool: d.tool, args: d.args, explanation: d.explanation, dependsOn: deps };
  });
}
