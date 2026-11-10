// Public addresses of the deployed app.
//   Frontend (Vercel): https://blizz-board-frontend.vercel.app
//   Backend  (Render): https://blizz-board-backend.onrender.com
// FRONTEND_URL / BACKEND_URL in .env (or the hosting dashboard) override them; on your own
// computer (not production) the local dev addresses are used.
// These are functions on purpose: .env is loaded after the modules are imported.

export const PRODUCTION_FRONTEND_URL = "https://blizz-board-frontend.vercel.app";
export const PRODUCTION_BACKEND_URL = "https://blizz-board-backend.onrender.com";

const clean = (url) => String(url || "").trim().replace(/\/+$/, "");

/** Running on Render (it sets RENDER=true) or with NODE_ENV=production */
export const isProduction = () =>
  process.env.NODE_ENV === "production" || String(process.env.RENDER || "").toLowerCase() === "true";

/** Where people open the app — used in email links (verification, tasks, meetings) */
export const frontendUrl = () =>
  clean(process.env.FRONTEND_URL) || (isProduction() ? PRODUCTION_FRONTEND_URL : "http://localhost:5173");

/** This API's own public address — used for the Google sign-in return address */
export const backendUrl = () =>
  clean(process.env.BACKEND_URL) ||
  clean(process.env.RENDER_EXTERNAL_URL) || // set automatically by Render
  (isProduction() ? PRODUCTION_BACKEND_URL : `http://localhost:${process.env.PORT || 5000}`);
