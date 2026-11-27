import { useEffect } from "react";
import { useRouteError, isRouteErrorResponse, Link } from "react-router-dom";
import { CatoBrand } from "./CatoBrand";

export function ErrorBoundary() {
  const error = useRouteError();
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  useEffect(() => {
    console.error("Cato Perps page error", error);
  }, [error]);
  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "grid",
        placeItems: "center",
        padding: 24,
      }}
    >
      <section
        style={{
          maxWidth: 460,
          padding: 32,
          border: "1px solid #ffedcd25",
          borderRadius: 16,
          background: "#1a1a1a",
        }}
      >
        <CatoBrand />
        <h1 style={{ marginTop: 24, fontSize: 24, color: "#ffedcd" }}>
          {notFound ? "This page wandered off." : "The terminal couldn't load."}
        </h1>
        <p style={{ color: "#a7a0b8", margin: "12px 0 24px", lineHeight: 1.6 }}>
          {notFound
            ? "Head back to the trading terminal."
            : "Check your connection and reload. Reloading does not cancel open orders or close positions."}
        </p>
        {notFound ? (
          <Link to="/" style={{ color: "#fea911" }}>
            Back to trading
          </Link>
        ) : (
          <button
            onClick={() => window.location.reload()}
            style={{
              background: "#ffedcd",
              color: "#1c0d00",
              border: 0,
              borderRadius: 8,
              padding: "10px 18px",
              cursor: "pointer",
            }}
          >
            Reload terminal
          </button>
        )}
      </section>
    </main>
  );
}
