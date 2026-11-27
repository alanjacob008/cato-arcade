import { describe, it, expect } from "vitest";
import { GAMES_LINKS, clawHref, gamesActive } from "../links";

describe("Games menu", () => {
  it("lists Claw then Up Down, with Up Down still going to the VIP sign-in", () => {
    expect(GAMES_LINKS.map((l) => l.label)).toEqual(["Claw", "Up Down"]);
    expect(GAMES_LINKS[0].tag).toBe("Devnet");
    expect(GAMES_LINKS[1]).toEqual({ label: "Up Down", href: "/play", tag: "VIP" });
  });

  it("sends Claw to the real devnet game only when the flag is on", () => {
    expect(clawHref("1")).toBe("/claw/play");
    expect(clawHref(undefined)).toBe("/claw");
    expect(clawHref("0")).toBe("/claw");
  });

  it("highlights Games on every game route and nowhere else", () => {
    for (const path of ["/play", "/updown", "/updown/x", "/claw", "/claw/play"]) expect(gamesActive(path)).toBe(true);
    for (const path of ["/", "/swap", "/staking", "/wrapped", "/playground", "/clawback"]) expect(gamesActive(path)).toBe(false);
  });
});
