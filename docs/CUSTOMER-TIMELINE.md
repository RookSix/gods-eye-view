# Browser-local customer timeline

Use **Customer Timeline → Import CSV** to load an already geocoded local CSV. Required columns are `latitude`, `longitude`, and `date_of_first_contact`. Optional `contact_id`/`customer_id`/`client_id`/`id` identifies duplicate records; different customers at the same coordinates and date are retained. Without identity, only identical rows are duplicates. Optional `initials`/`label`/`name` supplies a sanitized display label. `first_contact_source` is preserved and summarized as date provenance.

Click **Focus** to frame the layer, **Reset** to return to its earliest date, then **Play**. New customers drop vertically and remain on the map. Pause, speed, and the date slider support chronological exploration. Clear removes the dataset and cancels pending animations. Refreshing requires importing again.

Coordinates must be finite and in bounds; missing coordinates and 0,0 are skipped. Invalid dates, unresolved coordinates, and duplicate records are counted. Dates are calendar dates interpreted at UTC midnight. The importer does not verify that a supplied date represents an actual first inquiry: CRM creation and first service dates remain labeled as such.

The drop begins approximately 900 meters above the final relative-to-ground marker height and eases to the exact supplied latitude/longitude. No coordinate jitter or geocoding is performed. Co-located customers can visually overlap even though all are counted.

## Privacy

The importer reads the file into browser memory only. It does not upload the CSV, store it in localStorage/IndexedDB, embed it in a share URL, or attach it to shared app state. Keep actual customer files outside the repository. The rest of the map application can still request public basemap tiles and other enabled public layers; this is not a claim that the entire app has no network traffic.

## Verification

Synthetic parser and animation regressions:

`node --test src/layers/customerPoints/model.test.mjs src/layers/customerPoints/index.animation.test.mjs`

Also run `npm run build`. Browser acceptance should check imported/skipped counts, cumulative maximum, reverse seeking, reset, playback, exact final landing, and clear/animation cancellation. Browser automation can throttle animation frames in hidden tabs: bring the page to the foreground and avoid assuming an immediate second evaluation occurs after a complete animation.
