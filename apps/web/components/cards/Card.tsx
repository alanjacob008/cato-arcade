import { THEME } from "../../lib/shareModel";
import type { RevealCard } from "../../lib/revealModel";

export function Card({ card }: { card: RevealCard }) {
  return (
    <section
      style={{
        border: `1px solid #26262b`,
        borderLeft: `4px solid ${THEME.accent}`,
        borderRadius: 16,
        padding: 24,
        background: "linear-gradient(160deg, #16161a, #0d0d0f)",
      }}
    >
      <h2 style={{ margin: "0 0 12px", fontSize: 22 }}>{card.title}</h2>
      {card.note && <p style={{ color: THEME.muted, margin: "0 0 12px", fontSize: 14 }}>{card.note}</p>}
      {card.items.length > 0 && (
        <dl style={{ margin: 0 }}>
          {card.items.map((item, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 16,
                padding: "8px 0",
                borderTop: i ? "1px solid #222" : "none",
              }}
            >
              <dt style={{ color: THEME.muted }}>{item.label}</dt>
              <dd style={{ margin: 0, fontWeight: 600, textAlign: "right" }}>{item.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
