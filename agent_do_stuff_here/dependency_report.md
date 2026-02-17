# Dependency Report

## Third‑Party Libraries Used in This Project

| Library | Language | Typical Use Case |
|---------|----------|------------------|
| **Bottle** | Python | Lightweight web framework for building small HTTP services. It is used in `app/app.js` and the accompanying Flask‑style routes to expose REST endpoints.
| **React** | JavaScript/TypeScript | Declarative UI library for building component‑based interfaces. The project contains several React components (`src/Header.jsx`, `src/user-service.ts`) that render dynamic pages such as the timer, tic‑tac‑toe and hangman games.
| **Axios** | JavaScript/TypeScript | Promise‑based HTTP client used by the front‑end to fetch data from the Bottle back‑end. It is imported in `app/app.js` and several component files.
| **NumPy** | Python | Numerical computing library for efficient array operations. Used in `math_utils.py` for matrix calculations.
| **Pandas** | Python | Data manipulation and analysis library. Imported in `products.py` to read CSV/Excel data.

## Three Most Frequently Used Libraries
1. **Bottle** – Handles all HTTP routing, request parsing, and response generation for the back‑end API.
2. **React** – Powers the interactive front‑end; components are re‑rendered on state changes, enabling real‑time updates in games and timers.
3. **Axios** – Simplifies AJAX calls from the browser to the Bottle server, providing automatic JSON parsing and error handling.

These three libraries form the core of the application’s architecture: Bottle provides the API layer, React builds the UI, and Axios connects them together via HTTP requests.