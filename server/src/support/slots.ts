import type { TextFilter } from "../gateway/executor.ts";

// Demo company profile: fills the dataset's {{placeholders}} so neither the prompt nor the
// answer carries template slots.
const PROFILE: Record<string, string> = {
  "Order Number": "your order number",
  "Invoice Number": "your invoice number",
  "Tracking Number": "your tracking number",
  "Customer Support Phone Number": "+62 21 5000 1234",
  "Customer Support Hours": "Monday to Friday, 08:00–17:00 WIB",
  "Customer Support Email": "support@demo-shop.example",
  "Website URL": "demo-shop.example",
  "Login Page URL": "demo-shop.example/login",
  "Company Name": "Demo Shop",
  "Online Company Portal Info": "the Demo Shop website",
  "Online Order Interaction": "Cancel Order",
  "Account Type": "Premium",
  "Account Category": "Standard",
  "Salutation": "",
  "Client Last Name": "",
  "Client Name": "",
  "Person Name": "",
  "Currency Symbol": "Rp",
};

export function fillSlot(name: string): string {
  if (name in PROFILE) return PROFILE[name];
  return name.toLowerCase(); // e.g. {{Refund Amount}} -> "refund amount": readable, no braces
}

export const fillSlots = (s: string) => s.replace(/\{\{([^}]+)\}\}/g, (_, n: string) => fillSlot(n.trim())).replace(/ {2,}/g, " ");

// Streaming version: holds back text from "{{" until "}}" arrives, then substitutes.
export function slotFilter(): TextFilter {
  let held = "";
  const f: TextFilter = {
    changed: false,
    push(t: string) {
      held += t;
      let out = "";
      for (;;) {
        const open = held.indexOf("{{");
        if (open === -1) {
          // A trailing "{" may be the start of "{{".
          const keep = held.endsWith("{") ? 1 : 0;
          out += held.slice(0, held.length - keep);
          held = held.slice(held.length - keep);
          return out;
        }
        const close = held.indexOf("}}", open + 2);
        if (close === -1) {
          if (held.length - open > 60) { out += held; held = ""; return out; } // not a slot; give up holding
          out += held.slice(0, open);
          held = held.slice(open);
          return out;
        }
        out += held.slice(0, open) + fillSlot(held.slice(open + 2, close).trim());
        f.changed = true;
        held = held.slice(close + 2);
      }
    },
    flush() {
      const rest = held;
      held = "";
      return rest;
    },
  };
  return f;
}
