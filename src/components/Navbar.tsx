import { Link, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Menu, X } from "lucide-react";
import { useState } from "react";
import { useAuth } from "@/contexts/AuthContext";

const Navbar = () => {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const isDashboard = location.pathname.startsWith("/dashboard");
  const { user } = useAuth();

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 border-b border-border/50 bg-background/80 backdrop-blur-xl">
      <div className="container mx-auto flex h-16 items-center justify-between px-4">
        <Link to="/" className="flex items-center gap-2">
          <img src="/exwadda-icon.png" alt="ExWadda" className="h-7 w-7" />
          <span className="font-heading text-xl font-bold tracking-tight">ExWadda</span>
        </Link>

        {/* Desktop */}
        <div className="hidden items-center gap-6 md:flex">
          {!isDashboard && (
            <>
              <Link to="/#features" className="text-sm text-muted-foreground hover:text-foreground transition-colors">Features</Link>
              <Link to="/#how-it-works" className="text-sm text-muted-foreground hover:text-foreground transition-colors">How It Works</Link>
              <Link to="/#pricing" className="text-sm text-muted-foreground hover:text-foreground transition-colors">Pricing</Link>
            </>
          )}
          {user ? (
            <Link to="/dashboard">
              <Button variant="hero" size="sm">Dashboard</Button>
            </Link>
          ) : (
            <>
              <Link to="/login">
                <Button variant="ghost" size="sm">Log In</Button>
              </Link>
              <Link to="/register">
                <Button variant="hero" size="sm">Get Started</Button>
              </Link>
            </>
          )}
        </div>

        {/* Mobile toggle */}
        <button className="md:hidden" onClick={() => setOpen(!open)}>
          {open ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
        </button>
      </div>

      {/* Mobile menu */}
      {open && (
        <div className="border-t border-border bg-background p-4 md:hidden">
          <div className="flex flex-col gap-3">
            <Link to="/login" onClick={() => setOpen(false)}>
              <Button variant="ghost" className="w-full">Log In</Button>
            </Link>
            <Link to="/register" onClick={() => setOpen(false)}>
              <Button variant="hero" className="w-full">Get Started</Button>
            </Link>
          </div>
        </div>
      )}
    </nav>
  );
};

export default Navbar;
