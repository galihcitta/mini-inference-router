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
  "Date Range": "3–5",
  "Store Location": "our Jakarta store",
  "Refund Amount": "the refund amount",
  "Money Amount": "the amount",
  "Delivery City": "your city",
  "Delivery Country": "your country",
  "Customer Support Live Chat URL": "demo-shop.example/chat",
  "Account Recovery Page URL": "demo-shop.example/recover",
  "Password Reset Page URL": "demo-shop.example/reset",
};

export function fillSlot(name: string): string {
  if (name in PROFILE) return PROFILE[name];
  return name.toLowerCase(); // e.g. {{Refund Amount}} -> "refund amount": readable, no braces
}

export const fillSlots = (s: string) => s.replace(/\{\{([^}]+)\}\}/g, (_, n: string) => fillSlot(n.trim())).replace(/ {2,}/g, " ");

// Streaming version: holds back text from "{{" until "}}" arrives, then substitutes. Also drops
// whitespace before the first visible character (the newline after the intent header can arrive
// in its own chunk).
export function slotFilter(): TextFilter {
  let held = "";
  let started = false;
  const f: TextFilter = {
    changed: false,
    push(t: string) {
      if (!started) {
        t = t.trimStart();
        if (!t) return "";
        started = true;
      }
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
