const contacts = [
  {
    id: "contact-jana",
    name: "Jana Krüger",
    email: "jana.krueger@nordhafen.example",
    status: "active",
  },
  {
    id: "contact-tim",
    name: "Tim Becker",
    email: "tim.becker@rheinfracht.example",
    status: "pending",
  },
  {
    id: "contact-sara",
    name: "Sara Yilmaz",
    email: "sara.yilmaz@ostwind-handel.example",
    status: "active",
  },
];
const orders = [
  { id: "order-alpha", customer: "Jana Krüger", total: 129.5, currency: "EUR", status: "paid" },
  { id: "order-beta", customer: "Tim Becker", total: 42, currency: "EUR", status: "open" },
];

Bun.serve({
  port: 8080,
  hostname: "0.0.0.0",
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/health") return Response.json({ status: "ok", fixture: true });
    if (path === "/contacts")
      return Response.json({ items: contacts, contacts, total: contacts.length });
    if (path === "/orders") return Response.json({ items: orders, orders, total: orders.length });
    if (path === "/report")
      return Response.json({
        title: "Weekly sales report",
        contacts: contacts.length,
        orders: orders.length,
        revenue: 171.5,
        currency: "EUR",
      });
    if (path === "/fail")
      return Response.json(
        { code: "demo_failure", message: "Status service unavailable" },
        { status: 503 },
      );
    if (path === "/echo") {
      const raw = await request.text();
      let body: unknown = raw;
      try {
        body = JSON.parse(raw);
      } catch {}
      return Response.json({ accepted: true, fixture: true, method: request.method, body });
    }
    return Response.json({ code: "not_found", fixture: true }, { status: 404 });
  },
});
