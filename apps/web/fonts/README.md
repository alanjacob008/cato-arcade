# Fonts

Self-hosted so builds never depend on Google Fonts (next/font/google once shipped
Google's 404 page as a .woff2 on Vercel).

| File | Family | Use | Source |
|---|---|---|---|
| `Rubik.woff2` | Rubik, variable weight 300 to 900, Latin subset | Body text, UI and numbers (`--font-brand`) | Fontsource `@fontsource-variable/rubik` |
| `BricolageGrotesque.woff2` | Bricolage Grotesque, variable weight 200 to 800, Latin subset | Headlines and hero numbers (`--font-display`); every h1 and h2 picks it up from `app/globals.css` | Fontsource `@fontsource-variable/bricolage-grotesque` |

Both are licensed under the SIL Open Font License 1.1, which allows bundling with the site.
