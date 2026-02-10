import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "./hooks/useAuth";
import { SocketProvider } from "./hooks/useSocket";
import TitleBar from "./components/layout/TitleBar";
import Home from "./pages/Home";
import Login from "./pages/Login";
import Settings from "./pages/Settings";

function App() {
  return (
    <AuthProvider>
      <SocketProvider>
        <BrowserRouter>
          <TitleBar />
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/login" element={<Login />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </BrowserRouter>
      </SocketProvider>
    </AuthProvider>
  );
}

export default App;
