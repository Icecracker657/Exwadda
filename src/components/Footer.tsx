import { Link } from "react-router-dom";

const Footer = () => (
  <footer className="border-t border-border bg-secondary py-12">
    <div className="container mx-auto px-4">
      <div className="grid gap-8 md:grid-cols-4">
        <div>
          <div className="flex items-center gap-2 mb-4">
            <img src="/exwadda-icon.png" alt="ExWadda" className="h-6 w-6" />
            <span className="font-heading text-lg font-bold text-secondary-foreground">ExWadda</span>
          </div>
          <p className="text-sm text-muted-foreground">Kenya's trusted ExWadda platform for secure online transactions btn buyer ans sellers.</p>
        </div>
        <div>
          <h4 className="mb-3 font-heading text-sm font-semibold text-secondary-foreground">Platform</h4>
          <div className="flex flex-col gap-2 text-sm text-muted-foreground">
            <Link to="/#features" className="hover:text-primary transition-colors">Features</Link>
            <Link to="/#how-it-works" className="hover:text-primary transition-colors">How It Works</Link>
            <Link to="/#pricing" className="hover:text-primary transition-colors">Pricing</Link>
          </div>
        </div>
        <div>
          <h4 className="mb-3 font-heading text-sm font-semibold text-secondary-foreground">Legal</h4>
          <div className="flex flex-col gap-2 text-sm text-muted-foreground">
            <Link to="/terms" className="hover:text-primary transition-colors">Terms of Service</Link>
            <Link to="/privacy" className="hover:text-primary transition-colors">Privacy Policy</Link>
            <Link to="/escrow-agreement" className="hover:text-primary transition-colors">ExWadda Agreement</Link>
          </div>
        </div>
        <div>
          <h4 className="mb-3 font-heading text-sm font-semibold text-secondary-foreground">Support</h4>
          <div className="flex flex-col gap-2 text-sm text-muted-foreground">
            <a href="mailto:support@exwadda.co.ke" className="hover:text-primary transition-colors">support@exwadda.co.ke</a>
            <span>Nairobi, Kenya</span>
          </div>
        </div>
      </div>
      <div className="mt-8 border-t border-border pt-6 text-center text-xs text-muted-foreground">
        © {new Date().getFullYear()} ExWadda. All rights reserved 2026.
      </div>
    </div>
  </footer>
);

export default Footer;
