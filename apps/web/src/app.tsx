import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Shell } from "./components/shell";
import { ElementHealthPage } from "./pages/element-health";
import { ComplaintsPage } from "./pages/complaints";
import { RepliesPage } from "./pages/replies";
import { ManualProductsPage } from "./pages/manual-products";
import { RunCenter } from "./pages/run-center";
import { SettingsPage } from "./pages/settings";
import { TemplatesPage } from "./pages/templates";
import { useUiSession } from "./session/use-ui-session";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false, staleTime: 10_000 },
    mutations: { retry: false },
  },
});

export function resetAppQueryCacheForTests() {
  queryClient.clear();
}

export function App() {
  useUiSession();
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route element={<Shell />}>
            <Route index element={<RunCenter />} />
            <Route path="replies" element={<RepliesPage />} />
            <Route path="complaints" element={<ComplaintsPage />} />
            <Route path="templates" element={<TemplatesPage />} />
            <Route path="manual-products" element={<ManualProductsPage />} />
            <Route path="health" element={<ElementHealthPage />} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
