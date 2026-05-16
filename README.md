# QuoteIQ — Location-Based Pricing Optimizer

A multi-tenant SaaS web application that helps waste & recycling service companies set competitive, data-driven prices by clustering customer locations, computing road-based nearest-neighbor distances, and applying a configurable pricing engine.

**Live app:** https://quoteiq-app.web.app

---

## Features

### Map & Clustering
- **Drag-and-drop Excel upload** — drop your `.xlsx` file or click to browse
- **DBSCAN geographic clustering** via TurfJS — groups nearby accounts into competitive zones using straight-line Haversine distance
- **Re-cluster instantly** — change Epsilon or Min Points and re-run with zero API calls (coordinates are cached after the first run)
- **Road-based nearest-neighbor distance** — automatically uses OSRM (Open Source Routing Machine) for free, keyless driving distances based on OpenStreetMap data. No API key required.
- **OpenRouteService (optional)** — enter an ORS API key to use ORS drive-time distances instead of OSRM
- **"↺ Drive Times" button** — recompute road distances on demand without re-uploading the file
- **Leaflet map** — color-coded cluster markers with popups showing account number, address, cluster, and nearest-neighbor distance

### Pricing Engine
- **PI Rate** — apply a target price increase % to every account
- **Comp Area matching** — if a competitor's price exists for a cluster + container size, use it as a floor
- **Min Base Price floor** — no account falls below your defined minimum
- **Preferred Price ceiling** — `Preferred Price × (1 + Pref Buffer)` caps the new rate
- **Quantity discount** — blended per-unit average when `Mult > 1`: `(prefAdj × (Mult−1) × (1−Discount) + prefAdj) / Mult`
- **Outlier surcharge** — extra $/mile when road distance to nearest neighbor exceeds Epsilon (applies regardless of cluster membership, since DBSCAN uses straight-line distance while the surcharge uses road distance)
- **Hold logic** — if the current price already beats the competitor match, price is held

### Processed Data Tab
- Sortable columns — click any header to cycle asc → desc → none
- Calculated columns highlighted in blue: **PI'd Price, Price Match, Min Price, Pref Price Adj, Ceiling, New Rate, $ Change, % Change**
- Color-coded % Change pills (green = increase, red = decrease)
- Unmapped service codes shown in red with a prompt to update the Service Codes tab
- Distance column shows **road miles** (OSRM/ORS), not straight-line

#### Pricing Column Logic
| Column | Logic |
|--------|-------|
| **PI'd Price** | `Current Amount × (1 + PI Rate)` |
| **Price Match** | Comp Area price for this cluster + container size (if found) |
| **Min Price** | Minimum base price for this container size |
| **Pref Price Adj** | Preferred price + outlier surcharge, then blended for quantity: `(prefAdj × (Mult−1) × (1−Discount) + prefAdj) / Mult` |
| **Ceiling** | Hard cap based on the raw Preferred Price lookup: `Preferred Price × (1 + Pref Buffer)` — independent of surcharge or quantity adjustments |
| **New Rate** | `max(Min Price, min(Ceiling, max(PI'd Price, Price Match)))` |
| **$ Change** | `New Rate − Current Amount` |
| **% Change** | `$ Change / Current Amount × 100` |

### Service Code Table
- Maps service codes (e.g. `F2Y1W1`) to container sizes — **required field**; no regex fallback
- Auto-populates unique codes from the first Excel upload when the table is empty
- Empty container size fields are highlighted in red as required
- Accounts with unmapped codes are flagged in Processed Data
- Editable in-app; persists to Firestore per company
- "Clear Table" button resets it so the next upload re-populates from that file

### Named Sessions
- **💾 Save** — name and save the current processed dataset to Firebase Storage
- **📂 Sessions** — browse all saved sessions, load, rename, or delete them
- Sessions persist across browser refreshes — most recent session auto-restores on login
- Each session stores the full GeoJSON feature set; pricing is recalculated live on load using current settings

### Dashboard & Export
- Revenue summary: current vs. projected monthly revenue, net change
- Account summary: increases, holds, noise/outlier counts
- **Export to Excel** — Processed Data + Comp Areas + Min/Pref Price sheets
- **Export PDF Report** — formatted revenue summary via html2canvas + jsPDF

### Admin Panel (Superuser)
- Accessible at `/admin.html` or via the **⚙ Admin** button in the app top bar (visible to superusers only)
- **Companies tab** — add companies, activate/deactivate
- **Users tab** — view all users across all companies, activate/deactivate
- **Invites tab** — generate 7-day invite links per company

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Hosting | Firebase Hosting |
| Auth | Firebase Auth (Email/Password + Google SSO) |
| Database | Cloud Firestore |
| File storage | Firebase Storage (Blaze plan) |
| Clustering | TurfJS `clustersDbscan` |
| Drive times | OSRM public API (default, free) · OpenRouteService Matrix API (optional) |
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
    db.js             # Firestore read/write helpers, session CRUD, debounce
    app.js            # All app logic: clustering, OSRM, pricing engine, rendering
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

  /compAreas/{id}         — competitor area prices
  /minPrices/{id}         — minimum base prices by container size
  /prefPrices/{id}        — preferred prices by container size
  /serviceCodeTable/{id}  — service code → container size mapping (required)
  /uploads/{id}           — upload metadata; GeoJSON stored in Firebase Storage
  /sessions/{id}          — named session metadata; GeoJSON stored in Firebase Storage

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
| `Svc_Code_Alpha` | Required — must exist in Service Code Table |
| `Amount` | Recommended — current monthly price |
| `Mult` | Recommended — quantity/multiplier |
| `TotalAmount` | Recommended — used in Dashboard |

### Mode 2 — Geocode Address
`Account#`, `Service Add Num`, `Service Address`, `Service City`, `Service State`

---

## Pricing Driver Parameters

| Parameter | Description |
|-----------|-------------|
| **Epsilon** | Clustering radius in straight-line miles (DBSCAN). Accounts within Epsilon of each other form a cluster. |
| **Min Points** | Minimum accounts required to form a cluster. |
| **Qty Discount** | Discount applied to Preferred Price when `Mult > 1`. Uses blended per-unit formula. (e.g. `30%`) |
| **Extra $/Mile** | Surcharge per road mile beyond Epsilon from the nearest neighbor. |
| **PI Rate** | Target price increase percentage applied to current amounts. (e.g. `10%`) |
| **Pref Buffer** | Price ceiling multiplier: `Preferred Price × (1 + Pref Buffer%)`. (e.g. `40%`) |
| **ORS API Key** | Optional. Free key from [openrouteservice.org](https://openrouteservice.org). Leave blank to use OSRM (free, no key required). |

---

## Drive Time Distance Notes

QuoteIQ uses **road-based driving distances** for nearest-neighbor calculations by default:

- **OSRM** (default) — Public demo server at `router.project-osrm.org`, free, no API key required. Uses OpenStreetMap road data. Returns distances in road miles.
- **OpenRouteService** — Enter an ORS key to use ORS instead. Also road-based.
- **DBSCAN clustering** uses straight-line (Haversine) distance internally — this is intentional and standard for geographic clustering.
- Because DBSCAN uses straight-line and the surcharge uses road distance, an account can be **inside a cluster yet still receive an outlier surcharge** if its road distance to the nearest neighbor exceeds Epsilon. This is by design.

---

## Multi-Tenant / Auth

- **Superuser** — sees all companies; manages users, companies, and invites via `/admin.html`. Identified by `role: "superuser"` in `/users/{uid}`. A **⚙ Admin** button appears in the top bar.
- **Company user** — sees only their company's data; all pricing tables, sessions, and uploads are isolated per `companyId`
- **Invite flow** — superuser generates a 7-day invite link; new user signs up via `/join.html?token=...`
- **Deactivation** — sets `status: inactive`; Firestore security rules block access but all data is preserved; reactivation restores full access instantly

---

## Local Development

```bash
# Install Firebase CLI
npm install -g firebase-tools

# Authenticate
firebase login

# Serve locally (emulates Hosting)
firebase serve --only hosting

# Deploy hosting only
firebase deploy --only hosting

# Deploy everything
firebase deploy --only hosting,firestore,storage
```

> **Note:** Firebase Storage requires the **Blaze (pay-as-you-go)** plan. Session save/restore depends on Storage. On Spark (free), the save button is hidden and data processes normally within the session only.

---

## Setup Checklist

- [ ] Enable Email/Password and Google auth in Firebase Console → Authentication → Sign-in method
- [ ] Create Firestore database (Production mode, `nam5`)
- [ ] Create Firebase Storage bucket and paste `storage.rules` content in Firebase Console → Storage → Rules
- [ ] Add Firebase config to `public/js/firebase-init.js`
- [ ] Create superuser Firestore document by running `node setSuperuser.js` (requires service account key)
- [ ] `firebase deploy`
