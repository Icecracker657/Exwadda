import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type Status = "pending_approval" | "approved" | "funded" | "delivered" | "accepted" | "released" | "disputed" | "pending";

const statusConfig: Record<Status, { label: string; className: string }> = {
  pending_approval: { label: "Pending Approval", className: "bg-muted text-muted-foreground" },
  pending: { label: "Pending", className: "bg-muted text-muted-foreground" },
  approved: { label: "Approved", className: "bg-kenya-gold/20 text-kenya-gold border-kenya-gold/30" },
  funded: { label: "Funded", className: "bg-kenya-gold/20 text-kenya-gold border-kenya-gold/30" },
  delivered: { label: "Delivered", className: "bg-primary/15 text-primary border-primary/30" },
  accepted: { label: "Accepted", className: "bg-primary/25 text-primary border-primary/40" },
  released: { label: "Released", className: "bg-primary/30 text-primary border-primary/50" },
  disputed: { label: "Disputed", className: "bg-accent/15 text-accent border-accent/30" },
};

const TransactionStatusBadge = ({ status }: { status: Status }) => {
  const config = statusConfig[status];
  return (
    <Badge variant="outline" className={cn("font-medium", config.className)}>
      {config.label}
    </Badge>
  );
};

export default TransactionStatusBadge;
