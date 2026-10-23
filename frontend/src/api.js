// One place for the backend address (override with VITE_API_URL)
export const API = import.meta.env.VITE_API_URL || `http://${window.location.hostname}:8000`
