# QuoteIQ — Location-Based Pricing Optimizer

A multi-tenant SaaS web application that helps waste & recycling service companies set competitive, data-driven prices by clustering customer locations, computing nearest-neighbor distances, and applying a configurable pricing engine.

**Live app:** https://quoteiq-app.web.app

---

## Features

### Map & Clustering
- **Drag-and-drop Excel upload** — drop your `.xlsx` file or click to browse
- **DBSCAN geographic clustering** via TurfJS — groups nearby accounts into competitive zones
- **Re-cluster instantly** — change Epsilon or Min Points and re-run with zero API calls (coordinates are cached)
- **Nearest-neighbor distance** — straight-line (Turf) or drive-time (OpenRouteService API)
- **Leaflet map** — color-coded cluster markers with popups

### Pricing Engine
- **PI Rate** — apply a target price increase % to every account
- **Comp Area matching** — if a competitor's price exists for a cluster + container size, use it as a floor
- **Min Base Price floor** — no account falls below your minimum
- **Preferred Price ceiling** — `Preferred Price × (1 + Pref Buffer)` caps the new rate
- **Quantity discount** — applies when `Mult > 1` on a service line
- **Outlier surcharge** — extra $/mile for accounts beyond Epsilon from their nearest neighbor
- **Hold logic** — if current price already beats the competitor match, price is held

### Processed Data Tab
- Sortable columns (click headers to cycle asc → desc → none)
- Calculated columns highlighted in blue: PI'd Price, Price Match, Min Price, Pref Price Adj, Ceiling, New Rate, $ Change, % Change
- Color-coded % Change pills (green = increase, red = decrease)

### Service Code Table
- Maps service codes (e.g. `F2Y1W1`) to container sizes
- Auto-populates from the first Excel upload when the table is empty
- Editable in-app; persists to Firestore per company

### Dashboard & Export
- Revenue summary: current vs. projected monthly revenue, net change
- Account summary: increases, holds, noise/outlier counts
- **Export to Excel** — Processed Data + Comp Areas + Min/Pref Price sheets
- **Export PDF Report** — formatted revenue summary via html2canvas + jsPDF

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Hosting | Firebase Hosting |
| Auth | Firebase Auth (Email/Password + Google SSO) |
| Database | Cloud Firestore |
| File storage | Firebase Storage (Blaze plan) |
| Clustering | TurfJS `clustersDbscan` |
| Drive times | OpenRouteService Matrix API (optional) |
| Maps | Leaflet + OpenStreetMap |
| Excel | SheetJS (xlsx) |
| PDF | jsPDF + html2canvas |

---

## Project Structure

```
/public
  index.html          # Login / sign-up page
  app.html            # Main pricing optimizer (authenticated)
  admin.html          # Superuser dashboard
  join.html           # Invite acceptance (?token=...)
  /js
    firebase-init.js  # Firebase SDK config
    auth.js           # Login, logout, requireAuth, requireSuperuser
    db.js             # Firestore read/write helpers + debounce
    app.js            # All app logic: clustering, pricing engine, rendering
  /css
    shared.css        # Design system (tokens, buttons, tables, modals)
firebase.json         # Hosting + Firestore + Storage config
firestore.rules       # Security rules (per-company data isolation)
firestore.indexes.json
storage.rules
```

---

## Data Model (Firestore)

```
/companies/{companyId}
  name, status, createdAt, createdBy

  /settings/main
    epsilon, minPoints, quantityDiscount, extraChargePerMile,
    priceIncreaseRate, prefBuffer, orsKey

  /compAreas/{id}       — competitor area prices
  /minPrices/{id}       — minimum base prices by container size
  /prefPrices/{id}      — preferred prices by container size
  /serviceCodeTable/{id}— service code → container size mapping
  /uploads/{id}         — upload metadata; GeoJSON in Firebase Storage

/users/{uid}
  email, displayName, companyId, role, status, createdAt, invitedBy

/invites/{token}
  email, companyId, createdBy, role, expiresAt, used
```

---

## Required Excel Columns

### Mode 1 — Latitude / Longitude
| Column | Required |
|--------|----------|
| `Account#` | Required |
| `Latitude` | Required |
| `Longitude` | Required |
| `Svc_Code_Alpha` | Recommended |
| `Amount` | Recommended — current monthly price |
| `Mult` | Recommended — quantity/multiplier |
| `TotalAmount` | Recommended — used in Dashboard |

### Mode 2 — Geocode Address
`Account#`, `Service Add Num`, `Service Address`, `Service City`, `Service State`

---

## Pricing Driver Parameters

| Parameter | Description |
|-----------|-------------|
| **Qty Discount** | Discount applied to Preferred Price when `Mult > 1` (e.g. `30%`) |
| **Extra $/Mile** | Surcharge per mile for accounts beyond Epsilon from nearest neighbor |
| **PI Rate** | Target price increase percentage (e.g. `10%`) |
| **Pref Buffer** | Price ceiling = `Preferred Price × (1 + Pref Buffer%)` (e.g. `40%`) |
| **ORS API Key** | Free key from [openrouteservice.org](https://openrouteservice.org) for drive-time distances. Leave blank for straight-line. |

---

## Multi-Tenant / Auth

- **Superuser** — sees all companies; manages users, companies, and invites via `/admin.html`
- **Company user** — sees only their company's data
- **Invite flow** — superuser generates a 7-day invite link; new user signs up via `/join.html?token=...`
- **Deactivation** — sets `status: inactive`; user is blocked by Firestore rules but all data is preserved; reactivation restores full access instantly

---

## Local Development

```bash
# Install Firebase CLI
npm install -g firebase-tools

# Authenticate
firebase login

# Serve locally (emulates Hosting)
firebase serve --only hosting

# Deploy
firebase deploy --only hosting,firestore
```

> **Note:** Firebase Storage requires the **Blaze (pay-as-you-go)** plan. On Spark (free), upload persistence is skipped — data still processes and exports normally within the session.

---

## Setup Checklist

- [ ] Enable Email/Password and Google auth in Firebase Console → Authentication → Sign-in method
- [ ] Create Firestore database (Production mode, `nam5`)
- [ ] Create superuser Firestore document: `/users/{your-uid}` with `{ role: "superuser", status: "active", ... }`
- [ ] Add Firebase config to `public/js/firebase-init.js`
- [ ] `firebase deploy`
