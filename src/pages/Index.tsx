import { motion } from "framer-motion";
import { Lock, Zap, Users, ArrowRight, CheckCircle, Phone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Link } from "react-router-dom";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import heroBg from "@/assets/hero-bg.jpg";

const features = [
  { icon: Lock, title: "Secure Protection", desc: "Funds are held safely until both parties involved in the transactions confirm transaction terms are met." },
  { icon: Phone, title: "M-Pesa Integration", desc: "Deposit and withdraw via M-Pesa.And also the bank transaction feature for bank transactions" },
  { icon: Zap, title: "Instant Notifications", desc: "Real-time alerts on every transaction milestone via email and in-app and also messaging during the on-transaction period." },
  { icon: Users, title: "Dispute Resolution", desc: "Built-in arbitration system with admin oversight for fair outcomes and support 24/7 from the support team." },
];

const steps = [
  { num: "01", title: "Create Transaction", desc: "Buyer and seller agree on terms, amount, and delivery conditions." },
  { num: "02", title: "Fund ExWadda", desc: "Buyer deposits KES via M-Pesa or bank transfer. Funds are held securely during the transaction process." },
  { num: "03", title: "Deliver & Confirm", desc: "Seller delivers goods/services and confirms goods or services release. Buyer confirms satisfaction and confirms payment realease." },
  { num: "04", title: "Release Payment", desc: "Funds released to seller minus a 3% platform fee. Transparent pricing, no hidden charges." },
];

const fadeUp = {
  hidden: { opacity: 0, y: 30 },
  visible: (i: number) => ({ opacity: 1, y: 0, transition: { delay: i * 0.1, duration: 0.5 } }),
};

const Index = () => (
  <div className="min-h-screen">
    <Navbar />

    {/* Hero */}
    <section className="relative flex min-h-screen items-center justify-center overflow-hidden pt-16">
      <div className="absolute inset-0">
        <img src={heroBg} alt="" className="h-full w-full object-cover" />
        <div className="absolute inset-0 bg-secondary/90" />
      </div>
      <div className="container relative z-10 mx-auto px-4 py-20 text-center">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6 }}>
          <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/20 animate-pulse-glow">
            <img src="/exwadda-icon.png" alt="ExWadda" className="h-8 w-8" />
          </div>
          <h1 className="mx-auto max-w-3xl font-heading text-4xl font-bold tracking-tight text-secondary-foreground sm:text-5xl md:text-6xl">
            Secure Transactions for{" "}
            <span className="text-gradient-primary">Everyone including Kenya's Digital Economy</span>
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-lg text-muted-foreground">
            ExWadda protects buyers and sellers by holding funds until transaction conditions are met.  then the Payments are realeased upon confirmation and conditions met with M-Pesa or bank transfer.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-4 sm:flex-row">
            <Link to="/register">
              <Button variant="hero" size="lg" className="gap-2 text-base">
                Start Transacting <ArrowRight className="h-4 w-4" />
              </Button>
            </Link>
            <Link to="/#how-it-works">
              <Button variant="heroOutline" size="lg" className="text-base">
                How It Works
              </Button>
            </Link>
          </div>
        </motion.div>
      </div>
    </section>

    {/* Features */}
    <section id="features" className="py-24">
      <div className="container mx-auto px-4">
        <div className="text-center mb-16">
          <h2 className="font-heading text-3xl font-bold sm:text-4xl">Why ExWadda?</h2>
          <p className="mt-3 text-muted-foreground">Built for Kenyan buyers and sellers who demand trust during transactions.</p>
        </div>
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {features.map((f, i) => (
            <motion.div
              key={f.title}
              custom={i}
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true }}
              variants={fadeUp}
              className="group rounded-xl border border-border bg-card p-6 transition-all hover:shadow-elevated hover:border-primary/30"
            >
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                <f.icon className="h-6 w-6" />
              </div>
              <h3 className="font-heading text-lg font-semibold">{f.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{f.desc}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>

    {/* How it works */}
    <section id="how-it-works" className="bg-muted py-24">
      <div className="container mx-auto px-4">
        <div className="text-center mb-16">
          <h2 className="font-heading text-3xl font-bold sm:text-4xl">How It Works</h2>
          <p className="mt-3 text-muted-foreground">Four simple steps to a secure transaction.</p>
        </div>
        <div className="grid gap-8 md:grid-cols-2 lg:grid-cols-4">
          {steps.map((s, i) => (
            <motion.div
              key={s.num}
              custom={i}
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true }}
              variants={fadeUp}
              className="relative rounded-xl bg-card p-6 border border-border"
            >
              <span className="font-heading text-4xl font-bold text-primary/20">{s.num}</span>
              <h3 className="mt-2 font-heading text-lg font-semibold">{s.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{s.desc}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>

    {/* CTA */}
    <section className="bg-hero py-24">
      <div className="container mx-auto px-4 text-center">
        <h2 className="font-heading text-3xl font-bold text-primary-foreground sm:text-4xl">
          Ready to transact with confidence?
        </h2>
        <p className="mx-auto mt-4 max-w-lg text-primary-foreground/80">
          Join thousands of Kenyans who trust ExWadda for secure online transactions.
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-4 sm:flex-row">
          <Link to="/register">
            <Button size="lg" className="bg-card text-foreground hover:bg-card/90 gap-2 font-semibold">
              Create Free Account <ArrowRight className="h-4 w-4" />
            </Button>
          </Link>
        </div>
        <div className="mt-6 flex items-center justify-center gap-6 text-sm text-primary-foreground/70">
          <span className="flex items-center gap-1"><CheckCircle className="h-4 w-4" /> No setup fees</span>
          <span className="flex items-center gap-1"><CheckCircle className="h-4 w-4" /> M-Pesa ready</span>
          <span className="flex items-center gap-1"><CheckCircle className="h-4 w-4" /> 24/7 support</span>
        </div>
      </div>
    </section>

    <Footer />
  </div>
);

export default Index;
