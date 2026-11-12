import {
  serve,
  database,
  get,
  put,
  all,
  assert,
  fail,
  id,
  now,
  actor,
  own,
  items,
  call,
  requireInternal,
  internal,
  locked,
} from "../../shared/runtime.mjs";
const db = database("orders");
const order = (id) => {
  let o = get(db, id);
  assert(o, "Order not found", 404);
  return o;
};
async function action(o, act, b = {}) {
  if (act === "PAY") {
    assert(
      o.status === "PENDING_PAYMENT" || o.status === "PAID",
      "Order is not awaiting payment",
      409,
    );
    const payment = await call(
      "payments",
      `/internal/payments/${o.id}/capture`,
      "POST",
      { order: o, method: b.method },
    );
    put(db, { ...o, status: "PAID" });
    return payment;
  }
  if (act === "PREPARE") {
    assert(o.status === "PAID", "Shipment requires a paid order", 409);
    return call("shipping", `/internal/shipments/${o.id}/prepare`, "POST", {
      order: o,
    });
  }
  if (["SHIP", "TRANSIT", "DELIVER"].includes(act)) {
    const state = {
      SHIP: ["PAID", "SHIPPED"],
      TRANSIT: ["SHIPPED", "SHIPPED"],
      DELIVER: ["SHIPPED", "DELIVERED"],
    }[act];
    assert(
      o.status === state[0] || o.status === state[1],
      "Order cannot be shipped in this state",
      409,
    );
    const shipment = await call(
      "shipping",
      `/internal/shipments/${o.id}/advance`,
      "POST",
      {
        status: {
          SHIP: "SHIPPED",
          TRANSIT: "IN_TRANSIT",
          DELIVER: "DELIVERED",
        }[act],
      },
    );
    put(db, { ...o, status: state[1] });
    return shipment;
  }
  if (act === "CANCEL") {
    if (o.status === "CANCELLED") return o;
    assert(
      ["PENDING_PAYMENT", "PAID", "CANCELLING"].includes(o.status),
      "This order cannot be cancelled",
      409,
    );
    await call("shipping", `/internal/shipments/${o.id}/cancel`, "POST");
    o = put(db, { ...o, status: "CANCELLING" });
    await call("payments", `/internal/payments/${o.id}/refund`, "POST");
    await call("inventory", "/api/inventory/release", "POST", {
      items: o.items.map(({ productId, quantity }) => ({
        productId,
        quantity,
      })),
      reservationId: o.id,
    });
    return put(db, { ...o, status: "CANCELLED" });
  }
  fail(400, "Unknown action");
}
serve("orders", async (req, url, b) => {
  const p = url.pathname;
  const user = await actor(req);
  let m;
  if (req.method === "GET" && p === "/api/orders") {
    const uid = url.searchParams.get("userId") || user.id;
    assert(user.role === "SYSTEM" || uid === user.id, "Access denied", 403);
    return all(db).filter(
      (x) => x.userId === uid && !["CREATING", "REJECTED"].includes(x.status),
    );
  }
  if (req.method === "POST" && p === "/api/orders") {
    assert(b.userId === user.id, "Invalid userId", 403);
    const list = items(b.items);
    assert(
      b.customer &&
        ["name", "address", "city"].every(
          (k) => typeof b.customer[k] === "string" && b.customer[k].trim(),
        ),
      "Customer name, address and city required",
    );
    let key = req.headers["idempotency-key"];
    assert(!key || key.length < 150, "Invalid idempotency key");
    return locked("create:" + user.id + ":" + (key || id()), async () => {
      if (key) {
        let existing = all(db).find(
          (x) => x.userId === user.id && x.key === key,
        );
        if (existing) {
          assert(
            JSON.stringify(existing.request) ===
              JSON.stringify({ list, customer: b.customer }),
            "Idempotency payload conflict",
            409,
          );
          if (!["CREATING", "REJECTED"].includes(existing.status))
            return existing;
          if (existing.status === "REJECTED")
            fail(409, "Previous order attempt rejected");
        }
      }
      const priced = [];
      for (const x of list) {
        let product = await call("catalog", "/products/" + x.productId);
        priced.push({ ...x, name: product.name, price: product.price });
      }
      let total =
        priced.reduce((s, x) => s + Math.round(x.price * 100) * x.quantity, 0) /
        100;
      let o = (key &&
        all(db).find((x) => x.userId === user.id && x.key === key)) || {
        id: id(),
        userId: user.id,
        customer: b.customer,
        items: priced,
        total,
        status: "CREATING",
        createdAt: now(),
        ...(key ? { key } : {}),
        request: { list, customer: b.customer },
      };
      put(db, o);
      try {
        await call("inventory", "/api/inventory/reserve", "POST", {
          items: list,
          reservationId: o.id,
        });
      } catch (e) {
        if (e.status === 409) put(db, { ...o, status: "REJECTED" });
        throw e;
      }
      return put(db, { ...o, status: "PENDING_PAYMENT" });
    });
  }
  if (
    (m = p.match(/^\/internal\/orders\/([^/]+)\/action$/)) &&
    req.method === "POST"
  ) {
    requireInternal(req);
    return locked(m[1], () => action(order(m[1]), b.action, b));
  }
  if ((m = p.match(/^\/api\/orders\/([^/]+)$/)) && req.method === "GET")
    return own(user, order(m[1]));
  if (
    (m = p.match(/^\/api\/orders\/([^/]+)\/cancel$/)) &&
    req.method === "POST"
  )
    return locked(m[1], () => action(own(user, order(m[1])), "CANCEL"));
  if (
    (m = p.match(/^\/api\/orders\/([^/]+)\/status$/)) &&
    req.method === "PATCH"
  ) {
    let o = own(user, order(m[1]));
    if (o.status === b.status) return o;
    assert(
      internal(req),
      "Status transitions are coordinated by backend services",
      403,
    );
    fail(409, "Use internal action endpoint");
  }
  fail(404, "Not found");
});
