import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OUTPUT, renderMigrations } from "../../scripts/updown-migrations.mjs";
import { MIGRATIONS } from "../updownMigrations.generated.mjs";

describe("bundled Up Down migrations", () => {
  it("match apps/updown/db/*.sql (after changing them run: node scripts/updown-migrations.mjs, in apps/web)", () => {
    expect(readFileSync(OUTPUT, "utf8").replace(/\r\n/g, "\n")).toBe(renderMigrations());
    expect(MIGRATIONS.map((m) => m.name)).toEqual(["0011_updown_rounds.sql", "0012_updown_round_locks.sql", "0013_updown_account_case.sql"]);
  });
});
