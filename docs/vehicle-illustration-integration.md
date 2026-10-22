# Owner-supplied vehicle illustrations — 2026-10-22

Supersedes the previous photographic sourcing and withholding decisions for the current catalog presentation.

All 20 supplied JPEGs in `public/images/vehicles/` are mapped explicitly by CAR-01 through CAR-20 in `src/lib/catalog/vehicle-media.ts`. Original filenames and bytes are retained, including the model-name plates. No new image was generated, fetched, cropped, stretched or retouched. Assets are approximately 70–118 KB each, 504–515 pixels high and 505–768 pixels wide. The modest source resolution may limit sharpness in enlarged desktop previews.

The images are owner-supplied **AI concept illustrations**, not verified manufacturer photographs. No Commons authorship or Creative Commons licence is asserted for them. Earlier Commons credits in `vehicle-images.md` describe the unused legacy assets only; those files remain preserved under `public/vehicles/`.

The catalog displays one Hebrew AI illustration disclaimer. CSS uses `contain`, centered positioning, light ivory framing and no added shadows. Full source framing and plates remain visible; any edge clipping already present in the supplied image is not repaired or concealed.

Visual review: all 20 illustrate the named model families with their supplied plates. Exact generation, year, powertrain, badges and trim are not verified; Picanto and Sportage in particular have older-looking front designs than their filenames suggest. No substitute was introduced. CAR-16's existing SPORTAGE HEV / plug-in catalog discrepancy is unchanged. Canonical model names, groups, propulsion and eligibility still come from existing application data.

Browser verification uses the real catalog components in an isolated local Vite preview with thin Next Image/Link adapters and repository catalog fixtures. It does not use authenticated accounts, environment secrets or Supabase. Desktop 1440×1000: 20 cards, 20 images, zero initial fallbacks, three columns, no horizontal overflow. Mobile 390×844: one column, no horizontal overflow. Details and image zoom work; zoom remains within the mobile viewport, contains focus and restores focus after Escape. A deliberately blocked image exercises the error fallback. No browser exceptions recorded.

Screenshots are retained in the temporary `carwise-catalog-browser-g4CtkB` directory. A signed-in Next.js browser check remains necessary to verify the production image optimizer and real active catalog together.
