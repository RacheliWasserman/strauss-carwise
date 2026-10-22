# Brand assets

## Logo — the original CarWise W mark

The brand is the original CarWise W mark (`CarWiseMark` in `src/components/chat/chat-icon.tsx`) beside the
"CarWise." wordmark and "BY STRAUSS", rendered by `src/components/brand/brand-lockup.tsx` everywhere the brand
appears: chat sidebar (desktop and mobile drawer), sign-in, registration and profile-completion pages, and the
representative header. The wordmark is always laid out left to right inside the RTL interface. The Strauss flower
is **not** part of the logo (decision of 2026-10-22; the earlier flower asset was removed).

## `public/brand/petal-watermark.svg` — decorative petals

- Decorative background only: shown faintly behind the homepage (`.cw-petal-watermark`, `aria-hidden`,
  `pointer-events: none`) and on the sign-in panel.
- Strauss-inspired petal outlines, recoloured to mint, green, teal and pale blue only (no red or orange).
