import axios from "axios";

const API = axios.create({
  baseURL: "http://localhost:5000",
});

// ✅ FIX 1: Attach token to EVERY request automatically
API.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem("token");
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// ✅ FIX 2: Handle expired/invalid sessions globally
API.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error.response?.status;

    // 401 = token missing/expired → force re-login
    if (status === 401) {
      localStorage.removeItem("token");
      localStorage.removeItem("user");
      if (window.location.pathname !== "/login") {
        window.location.href = "/login";
      }
    }

    // 403 = logged in but not allowed → friendly log
    if (status === 403) {
      console.warn(
        "🔒 Permission denied:",
        error.config?.url,
        "— Your role may not have access to this resource."
      );
    }

    return Promise.reject(error);
  }
);

export default API;